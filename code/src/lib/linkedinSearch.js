// Stage 1 (Search) — LinkedIn guest "seeMoreJobPostings" scraper.
// See docs/flow.md for the full pipeline spec this implements.

const SEARCH_URL = "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search";
const PAGE_SIZE = 10;
const TIMEOUT_MS = 15_000;
const RETRY_BASE_MS = 500;
const RETRY_CAP_MS = 8_000;
const MAX_RETRIES = 6;

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "X-Requested-With": "XMLHttpRequest",
};

const WORK_TYPE = { onsite: 1, remote: 2, hybrid: 3 };

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffDelay(attempt) {
  const cap = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** attempt);
  return Math.random() * cap;
}

// LinkedIn occasionally answers with HTTP 200 but a tiny authwall redirect
// stub instead of real content (soft rate-limit, not a 429/5xx). Treat it
// the same as a retryable failure.
function isSoftRateLimited(body) {
  return body.length < 2000 && body.includes("authwall");
}

async function fetchWithRetry(url) {
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await sleep(backoffDelay(attempt - 1));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers: HEADERS, signal: controller.signal });
      clearTimeout(timer);

      if (res.status === 404) {
        return { status: 404, body: "" };
      }
      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`LinkedIn search returned ${res.status}`);
        continue;
      }

      const body = await res.text();
      if (isSoftRateLimited(body)) {
        lastError = new Error("LinkedIn soft rate-limit (authwall) hit");
        continue;
      }

      return { status: res.status, body };
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
    }
  }
  throw lastError ?? new Error("LinkedIn search failed with no further detail");
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripTags(html) {
  return decodeEntities(html.replace(/<[^>]+>/g, "")).trim();
}

function matchText(chunk, regex) {
  const m = chunk.match(regex);
  return m ? stripTags(m[1]) : undefined;
}

// One job card chunk -> raw fields (url still has query params at this point).
function parseCardChunk(chunk) {
  const title =
    matchText(chunk, /<h3[^>]*base-search-card__title[^>]*>([\s\S]*?)<\/h3>/i) ??
    matchText(chunk, /<span[^>]*class="[^"]*sr-only[^"]*"[^>]*>([\s\S]*?)<\/span>/i);

  const subtitleMatch = chunk.match(/<h4[^>]*base-search-card__subtitle[^>]*>([\s\S]*?)<\/h4>/i);
  let company;
  let companyUrl;
  if (subtitleMatch) {
    const subtitle = subtitleMatch[1];
    const linkMatch = subtitle.match(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (linkMatch) {
      companyUrl = linkMatch[1];
      company = stripTags(linkMatch[2]);
    } else {
      company = stripTags(subtitle);
    }
  }

  const location = matchText(chunk, /<span[^>]*class="[^"]*job-search-card__location[^"]*"[^>]*>([\s\S]*?)<\/span>/i);

  const dateMatch = chunk.match(
    /<(?:span|time)[^>]*class="[^"]*job-search-card__listdate[^"]*"[^>]*datetime="([^"]+)"/i
  );
  const date = dateMatch ? dateMatch[1] : undefined;

  const urlMatch = chunk.match(/<a[^>]*class="[^"]*base-card__full-link[^"]*"[^>]*href="([^"]+)"/i);
  const url = urlMatch ? decodeEntities(urlMatch[1]) : undefined;

  if (!title || !url) {
    return null; // not enough to identify/use this card — skip it, don't break the page
  }
  return { title, company, companyUrl, location, date, url };
}

// Splits raw search-result HTML into per-card chunks and parses each
// independently, so one malformed card can't take down the rest of the page.
function parseJobCards(html) {
  const marker = 'data-entity-urn="urn:li:jobPosting:';
  const chunks = html.split(marker).slice(1);
  const cards = [];
  for (const chunk of chunks) {
    try {
      const card = parseCardChunk(chunk);
      if (card) cards.push(card);
    } catch {
      // malformed chunk — skip, keep processing the rest
    }
  }
  return cards;
}

function stripQueryParams(url) {
  return url.split("?")[0];
}

function resolveWorkType(workType) {
  if (workType === undefined || workType === null || workType === "") return undefined;
  if (typeof workType === "number") return workType;
  const num = Number(workType);
  if (!Number.isNaN(num)) return num;
  const byName = WORK_TYPE[String(workType).toLowerCase()];
  if (!byName) throw new Error(`Unknown work type "${workType}" (expected onsite/remote/hybrid or 1/2/3)`);
  return byName;
}

/**
 * Stage 1 — Search. Fetches LinkedIn's public guest search endpoint,
 * paginating until `count` unique candidates are collected or results
 * are exhausted.
 *
 * @param {object} opts
 * @param {string} opts.keywords
 * @param {string} opts.location
 * @param {number} opts.count - how many unique candidates to collect
 * @param {number} [opts.recencySeconds] - f_TPR window, e.g. 604800 for 7 days
 * @param {number|string} [opts.workType] - 1|2|3 or "onsite"|"remote"|"hybrid"
 * @param {number} [opts.maxPages=50] - safety cap on pagination
 * @returns {Promise<Array<{id:number,title:string,company?:string,companyUrl?:string,location?:string,date?:string,url:string}>>}
 */
export async function searchJobs({ keywords, location, count, recencySeconds, workType, maxPages = 50 }) {
  if (!keywords) throw new Error("keywords is required");
  if (!location) throw new Error("location is required");
  if (!Number.isInteger(count) || count < 1) throw new Error("count must be a positive integer");

  const f_WT = resolveWorkType(workType);
  const seenUrls = new Set();
  const results = [];
  let page = 0;

  while (results.length < count && page < maxPages) {
    const start = page * PAGE_SIZE;
    const params = new URLSearchParams({ keywords, location, start: String(start) });
    if (recencySeconds) params.set("f_TPR", `r${recencySeconds}`);
    if (f_WT) params.set("f_WT", String(f_WT));

    const { status, body } = await fetchWithRetry(`${SEARCH_URL}?${params.toString()}`);
    if (status === 404) break; // no more results, not an error

    const cards = parseJobCards(body);
    if (cards.length === 0) break; // exhausted

    for (const card of cards) {
      const url = stripQueryParams(card.url);
      if (seenUrls.has(url)) continue;
      seenUrls.add(url);
      results.push({
        id: results.length + 1,
        title: card.title,
        company: card.company,
        companyUrl: card.companyUrl,
        location: card.location,
        date: card.date,
        url,
      });
      if (results.length >= count) break;
    }
    page += 1;
  }

  return results;
}

export { stripQueryParams, parseJobCards };

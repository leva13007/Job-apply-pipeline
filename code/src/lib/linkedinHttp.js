// Shared HTTP transport + HTML text primitives for LinkedIn scraping.
// Used by both Stage 1 (linkedinSearch.js) and Stage 2 (linkedinVacancy.js) —
// see docs/flow.md for the Robustness rules this implements.

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
        lastError = new Error(`LinkedIn request returned ${res.status}`);
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
  throw lastError ?? new Error("LinkedIn request failed with no further detail");
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

export {
  TIMEOUT_MS,
  RETRY_BASE_MS,
  RETRY_CAP_MS,
  MAX_RETRIES,
  HEADERS,
  sleep,
  backoffDelay,
  isSoftRateLimited,
  fetchWithRetry,
  decodeEntities,
  stripTags,
  matchText,
};

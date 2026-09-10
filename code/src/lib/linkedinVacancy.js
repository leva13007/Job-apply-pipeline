// Stage 2 (Extract vacancy data) — fetches each candidate's public LinkedIn
// job-view page directly and parses full vacancy details.
// See docs/flow.md ("Stage 2 — Extract vacancy data") for the full spec.

import { fetchWithRetry, sleep, decodeEntities, stripTags, matchText } from "./linkedinHttp.js";

const CRITERIA_KEY_MAP = {
  "seniority level": "seniority",
  "employment type": "employmentType",
  "job function": "jobFunction",
  industries: "industries",
};

// Newline-preserving flattening, distinct from linkedinHttp's stripTags
// (which fully flattens with no structure). Description text feeds Stage 3
// requirement matching, so line structure matters here.
function htmlBlockToText(html) {
  const withBreaks = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|blockquote)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ");

  const decoded = decodeEntities(withBreaks.replace(/<[^>]+>/g, ""));

  const lines = decoded.split("\n").map((line) => line.trim());
  const collapsed = lines.filter((line, i) => !(line === "" && lines[i - 1] === ""));
  return collapsed.join("\n").trim();
}

// matchText assumes the capture group is index 1, but this regex needs group
// 2 for the text (group 1 is the tag-name backreference) — matched directly.
function parseTitle(html) {
  const m = html.match(
    /<(h1|h2)[^>]*class="[^"]*(?:topcard__title|top-card-layout__title)[^"]*"[^>]*>([\s\S]*?)<\/\1>/i
  );
  return m ? stripTags(m[2]) : undefined;
}

function parseCompany(html) {
  const m = html.match(
    /<a[^>]*class="[^"]*topcard__org-name-link[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i
  );
  return m ? { companyUrl: decodeEntities(m[1]), company: stripTags(m[2]) } : {};
}

// Best-guess selector — not empirically confirmed in flow.md the way the
// other Stage 2 selectors are. Callers should fall back to the Stage 1
// candidate's location when this doesn't match.
function parseLocation(html) {
  return matchText(html, /<span[^>]*class="[^"]*topcard__flavor--bullet[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
}

function parseDescription(html) {
  const m =
    html.match(
      /<div[^>]*class="[^"]*show-more-less-html__markup[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<button/i
    ) ?? html.match(/<div[^>]*class="[^"]*description__text[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i);
  return m ? htmlBlockToText(m[1]) : undefined;
}

function parseJobCriteria(html) {
  const out = {};
  const itemRe = /<li[^>]*class="[^"]*description__job-criteria-item[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = itemRe.exec(html))) {
    const item = m[1];
    const label = matchText(
      item,
      /<h3[^>]*class="[^"]*description__job-criteria-subheader[^"]*"[^>]*>([\s\S]*?)<\/h3>/i
    );
    const value = matchText(
      item,
      /<span[^>]*class="[^"]*description__job-criteria-text[^"]*"[^>]*>([\s\S]*?)<\/span>/i
    );
    const key = label && CRITERIA_KEY_MAP[label.trim().toLowerCase()];
    if (key && value) out[key] = value;
  }
  return out;
}

// Best-effort only: presence of the banner is a signal the job is closed;
// its absence is NOT proof the job is still open (markup may simply have
// changed, or the banner may use different wording). No verified CSS
// selector exists for this banner as of 2026-09-10 — plain-text phrase
// search is the pragmatic fallback (see docs/flow.md).
function parseIsActive(html) {
  return !/no longer accepting applications/i.test(stripTags(html));
}

// The #topbar-apply element may be a <button> or <a> with attributes in any
// order, so grab its whole opening tag by locating the id="..." occurrence
// rather than assuming a fixed attribute layout. Also returns where the tag
// ends, so callers can look at what immediately follows it.
function locateTopbarApply(html) {
  const idx = html.indexOf('id="topbar-apply"');
  if (idx === -1) return undefined;
  const tagStart = html.lastIndexOf("<", idx);
  const tagEnd = html.indexOf(">", idx);
  if (tagEnd === -1) return undefined;
  return { tag: html.slice(tagStart, tagEnd + 1), endIndex: tagEnd + 1 };
}

function classifyApplyLinkSignal(name) {
  if (!name) return undefined;
  if (name.startsWith("public_jobs_apply-link-onsite") || name.startsWith("public_jobs_apply-link-simple_onsite")) {
    return "onsite";
  }
  if (name.startsWith("public_jobs_apply-link-offsite")) return "offsite";
  return undefined;
}

function parseApplyChannel(html) {
  const located = locateTopbarApply(html);
  const trackingControlName = located?.tag.match(/data-tracking-control-name="([^"]+)"/i)?.[1];

  let applyChannel = classifyApplyLinkSignal(trackingControlName);

  // For onsite applies, #topbar-apply's own data-tracking-control-name is
  // the signal directly (as above). For offsite applies LinkedIn sometimes
  // wraps the button in a contextual sign-in modal instead — in that case
  // the button's own attribute is a generic modal-trigger value, and the
  // real apply-link-offsite signal sits on a sibling element's
  // data-impression-id right after the button (empirically confirmed
  // 2026-09-10; flow.md only documents the direct-attribute case).
  if (!applyChannel && located) {
    const nearby = html.slice(located.endIndex, located.endIndex + 1500);
    const impressionId = nearby.match(/data-impression-id="(public_jobs_apply-link-[^"]*)"/i)?.[1];
    applyChannel = classifyApplyLinkSignal(impressionId);
  }

  // Secondary/corroborating detail only — empirically unreliable alone
  // (present on only 3/10 offsite examples per flow.md).
  const hasOffsiteIcon = /apply-button__offsite-apply-icon-svg/.test(html);

  return { applyChannel, applyTrackingControlName: trackingControlName, hasOffsiteIcon };
}

// Best-effort/TBD: only populated if #topbar-apply is itself an <a href="...">
// pointing at a non-linkedin.com host. In practice this element is often a
// <button> that triggers client-side JS/modal navigation, in which case this
// yields nothing — real ATS-domain detection is deferred to a future browser
// step (see docs/flow.md). No Greenhouse/Lever/Workday allowlist is kept.
function parseAtsInfo(html) {
  const located = locateTopbarApply(html);
  const href = located?.tag.match(/href="([^"]+)"/i)?.[1];
  if (!href) return {};
  try {
    const u = new URL(decodeEntities(href), "https://www.linkedin.com");
    if (u.hostname.endsWith("linkedin.com")) return {};
    return { applyUrl: u.href, atsHost: u.hostname };
  } catch {
    return {};
  }
}

function parseRecruiterContact(html) {
  const blockMatch = html.match(
    /<div[^>]*class="[^"]*message-the-recruiter[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i
  );
  const isMeetTheHiringTeam = Boolean(blockMatch);
  if (!blockMatch) return { recruiterContact: undefined, isMeetTheHiringTeam };

  const block = blockMatch[1];
  const rawProfileUrl = block.match(/<a[^>]*class="[^"]*base-card__full-link[^"]*"[^>]*href="([^"]+)"/i)?.[1];
  const profileUrl = rawProfileUrl ? decodeEntities(rawProfileUrl) : undefined;
  const name = matchText(block, /<h3[^>]*class="[^"]*base-main-card__title[^"]*"[^>]*>([\s\S]*?)<\/h3>/i);
  const title = matchText(block, /<h4[^>]*class="[^"]*base-main-card__subtitle[^"]*"[^>]*>([\s\S]*?)<\/h4>/i);

  return {
    recruiterContact: name || title || profileUrl ? { name, title, profileUrl } : undefined,
    isMeetTheHiringTeam,
  };
}

/**
 * Stage 2 — Extract vacancy data for one Stage 1 candidate.
 *
 * @param {{id:number,url:string,title?:string,company?:string,companyUrl?:string,location?:string,date?:string}} candidate
 * @returns {Promise<object>} vacancy object — see code/README.md for the full schema
 */
export async function extractVacancy(candidate) {
  const { status, body } = await fetchWithRetry(candidate.url);
  if (status === 404) {
    return { ...candidate, fetchStatus: "not_found" };
  }

  const { company, companyUrl } = parseCompany(body);
  const criteria = parseJobCriteria(body);
  const { applyChannel, applyTrackingControlName, hasOffsiteIcon } = parseApplyChannel(body);
  const { applyUrl, atsHost } = parseAtsInfo(body);
  const { recruiterContact, isMeetTheHiringTeam } = parseRecruiterContact(body);

  return {
    id: candidate.id,
    url: candidate.url,
    date: candidate.date,
    title: parseTitle(body) ?? candidate.title,
    company: company ?? candidate.company,
    companyUrl: companyUrl ?? candidate.companyUrl,
    location: parseLocation(body) ?? candidate.location,
    description: parseDescription(body),
    seniority: criteria.seniority,
    employmentType: criteria.employmentType,
    jobFunction: criteria.jobFunction,
    industries: criteria.industries,
    isActive: parseIsActive(body),
    applyChannel,
    applyTrackingControlName,
    hasOffsiteIcon,
    applyUrl,
    atsHost,
    recruiterContact,
    isMeetTheHiringTeam,
    fetchStatus: "ok",
  };
}

/**
 * Stage 2 — batch version. Fetches sequentially (not concurrently) with a
 * fixed inter-request delay: flow.md's empirical finding is that ~7-10 rapid
 * sequential requests trigger the soft-rate-limit/authwall response, so
 * pacing is applied on top of the existing per-request retry/backoff.
 *
 * @param {Array} candidates
 * @param {{delayMs?: number, onProgress?: (done:number,total:number)=>void}} [options]
 */
export async function extractVacancies(candidates, options = {}) {
  const { delayMs = 2000, onProgress } = options;
  const results = [];
  for (let i = 0; i < candidates.length; i++) {
    if (i > 0 && delayMs > 0) await sleep(delayMs);
    try {
      results.push(await extractVacancy(candidates[i]));
    } catch (err) {
      results.push({ ...candidates[i], fetchStatus: "error", fetchError: err.message });
    }
    onProgress?.(i + 1, candidates.length);
  }
  return results;
}

export { htmlBlockToText };

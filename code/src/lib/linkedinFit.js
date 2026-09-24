// Stage 3 (Match / fit) — deterministic hard-fit filters, stack must-have
// gate, and apply-channel rating. See docs/flow.md ("Stage 3 — Match / fit")
// for the full spec this implements.
//
// Not implemented here: Stage 3.5 (LLM review of borderline must-have
// cases) — this module only produces the `needsLlmReview` flag and stops,
// same split flow.md itself draws between "code decides" and "agent decides".

const SENIORITY_LEVELS = [
  "Internship",
  "Entry level",
  "Associate",
  "Mid-Senior level",
  "Director",
  "Executive",
];

// Starter list only — flow.md leaves "who maintains this table, how it
// grows when a new must-have skill shows up without an entry" as an open
// question. Extend/override via --synonyms <file.json> (merged over this).
const DEFAULT_STACK_SYNONYMS = {
  javascript: ["javascript", "js"],
  typescript: ["typescript", "ts"],
  node: ["node", "node.js", "nodejs"],
  react: ["react", "react.js", "reactjs"],
  "react native": ["react native", "reactnative"],
  python: ["python"],
  golang: ["golang", "go"],
  aws: ["aws", "amazon web services"],
  gcp: ["gcp", "google cloud"],
  azure: ["azure"],
  docker: ["docker"],
  kubernetes: ["kubernetes", "k8s"],
  postgresql: ["postgresql", "postgres"],
  mongodb: ["mongodb", "mongo"],
  graphql: ["graphql"],
};

// Canonical --channel names, per flow.md's Open questions list.
const CHANNEL_NAMES = {
  "easy-apply": 0,
  "linkedin-apply": 1,
  "external-ats": 2,
  "company-site": 3,
  "meet-the-hiring-team": 4,
};

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Symbol-safe "word" boundary: plain \b doesn't work for terms like
// "node.js" or "c#" since it only fires at \w/non-\w transitions. This
// instead just checks the term isn't glued to another alphanumeric on
// either side, which is enough for stack-keyword matching.
function termRegex(term) {
  return new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(term)}(?![A-Za-z0-9])`, "i");
}

function synonymsFor(skill, table) {
  const key = skill.trim().toLowerCase();
  return table[key] ?? [key];
}

// One entry per requested skill (not per synonym) in the caller's original
// casing — a skill counts as matched if any of its synonyms appears.
function matchStack(text, skills, synonyms = DEFAULT_STACK_SYNONYMS) {
  const matched = [];
  const missing = [];
  for (const skill of skills) {
    const terms = synonymsFor(skill, synonyms);
    const hit = terms.some((term) => termRegex(term).test(text));
    (hit ? matched : missing).push(skill);
  }
  return { matched, missing };
}

function seniorityIndex(level) {
  const idx = SENIORITY_LEVELS.findIndex((l) => l.toLowerCase() === String(level).trim().toLowerCase());
  return idx === -1 ? undefined : idx;
}

// Exact match by default. flow.md explicitly leaves "does 'Mid-Senior
// level' satisfy a 'Senior' search, or is an exact/adjacent match required"
// as an open question — `adjacent` opts into a +/-1 level tolerance instead
// of the code silently picking one interpretation.
function matchesSeniority(vacancySeniority, targetLevels, { adjacent = false } = {}) {
  if (!targetLevels?.length || !vacancySeniority) return true; // nothing to check against
  const vIdx = seniorityIndex(vacancySeniority);
  if (vIdx === undefined) return true; // unrecognized enum value — don't fail on it
  return targetLevels.some((target) => {
    const tIdx = seniorityIndex(target);
    if (tIdx === undefined) return false;
    return adjacent ? Math.abs(tIdx - vIdx) <= 1 : tIdx === vIdx;
  });
}

function matchesLocation(vacancyLocation, locationKeywords) {
  if (!locationKeywords?.length) return true;
  if (!vacancyLocation) return true; // best-effort: nothing to check against, don't fail
  const loc = vacancyLocation.toLowerCase();
  return locationKeywords.some((kw) => loc.includes(kw.trim().toLowerCase()));
}

function matchesEmploymentType(vacancyType, targetType) {
  if (!targetType) return true;
  if (!vacancyType) return true; // best-effort: don't fail on a missing field
  return vacancyType.trim().toLowerCase() === targetType.trim().toLowerCase();
}

// Best-effort, NOT empirically verified against real description text (see
// flow.md Open questions — unlike Stage 1/2's regexes, this one hasn't been
// checked against a sample). Picks the largest money-like number found as a
// proxy for "salary on offer": descriptions more often state a range's
// upper bound clearly than a lower one, and taking the max avoids
// under-counting on "£120-180k"-style ranges.
function extractSalaryMax(description) {
  if (!description) return undefined;
  const re = /[£$€]\s?\d[\d,.]*\s?[kK]?\b|\b\d{1,3}(?:,\d{3})+\b|\b\d{2,3}\s?[kK]\b/g;
  let max;
  let m;
  while ((m = re.exec(description))) {
    const raw = m[0];
    const isK = /[kK]$/.test(raw);
    const digits = raw.replace(/[£$€,\s]/g, "").replace(/[kK]$/, "");
    let n = Number(digits);
    if (Number.isNaN(n)) continue;
    if (isK) n *= 1000;
    if (max === undefined || n > max) max = n;
  }
  return max;
}

// { checked: false } means "skipped, not failed" — flow.md: salary is a
// best-effort check that's skipped (not a gate) when no number is found.
function matchesSalary(description, salaryMin) {
  if (!salaryMin) return { checked: false, pass: true };
  const found = extractSalaryMax(description);
  if (found === undefined) return { checked: false, pass: true };
  return { checked: true, pass: found >= salaryMin, found };
}

// { min, max } — the guaranteed-known range for the 0-4 apply-channel
// rating. Stage 2 only gives a coarse onsite/offsite split plus a reliable
// rating-4 signal (message-the-recruiter block) — 0 vs 1 and 2 vs 3 aren't
// resolvable from an unauthenticated fetch, hence a range, not a number.
function applyChannelRatingRange(vacancy) {
  if (vacancy.isMeetTheHiringTeam) return { min: 4, max: 4 };
  if (vacancy.applyChannel === "onsite") return { min: 0, max: 1 };
  if (vacancy.applyChannel === "offsite") return { min: 2, max: 3 };
  return { min: undefined, max: undefined };
}

function resolveChannelThreshold(channel) {
  if (channel === undefined || channel === null || channel === "") return undefined;
  if (typeof channel === "number") return channel;
  const num = Number(channel);
  if (!Number.isNaN(num)) return num;
  const byName = CHANNEL_NAMES[String(channel).toLowerCase()];
  if (byName === undefined) {
    throw new Error(`Unknown channel "${channel}" (expected 0-4 or ${Object.keys(CHANNEL_NAMES).join("/")})`);
  }
  return byName;
}

/**
 * Stage 3 — Match / fit for one Stage 2 vacancy.
 * See docs/flow.md ("Stage 3 — Match / fit") for the rubric this implements.
 *
 * @param {object} vacancy - Stage 2 output
 * @param {object} [criteria]
 * @param {string[]} [criteria.seniority] - target LinkedIn seniority enum value(s)
 * @param {boolean} [criteria.seniorityAdjacent] - allow +/-1 level tolerance (default: exact only)
 * @param {string[]} [criteria.locations] - location keyword(s), substring match
 * @param {string} [criteria.employmentType]
 * @param {number} [criteria.salaryMin] - best-effort, see extractSalaryMax
 * @param {string[]} [criteria.mustHave]
 * @param {string[]} [criteria.niceToHave] - tie-break only, not a gate
 * @param {object} [criteria.synonyms] - overrides/extends DEFAULT_STACK_SYNONYMS
 * @param {number|string} [criteria.channel] - min apply-channel rating (0-4) or name, see CHANNEL_NAMES
 * @returns {object} vacancy input augmented with Stage 3 fields (fitDecision/skipReason/needsLlmReview/missingMustHave/tieBreakScore/applyChannelRating/channelDecision)
 */
function evaluateFit(vacancy, criteria = {}) {
  const applyChannelRating = applyChannelRatingRange(vacancy);
  const text = `${vacancy.title ?? ""}\n${vacancy.description ?? ""}`;

  const skip = (reason) => ({ ...vacancy, applyChannelRating, fitDecision: "skip", skipReason: reason });

  if (!matchesSeniority(vacancy.seniority, criteria.seniority, { adjacent: criteria.seniorityAdjacent })) {
    return skip("seniority");
  }
  if (!matchesLocation(vacancy.location, criteria.locations)) {
    return skip("location");
  }
  if (!matchesEmploymentType(vacancy.employmentType, criteria.employmentType)) {
    return skip("employmentType");
  }
  const salary = matchesSalary(vacancy.description, criteria.salaryMin);
  if (salary.checked && !salary.pass) {
    return skip("salary");
  }

  const mustHave = criteria.mustHave ?? [];
  const { missing: missingMustHave } = matchStack(text, mustHave, criteria.synonyms);
  const niceToHave = criteria.niceToHave ?? [];
  const tieBreakScore = matchStack(text, niceToHave, criteria.synonyms).matched.length;

  let result;
  if (mustHave.length > 0 && missingMustHave.length === mustHave.length) {
    // 100% miss — not a borderline case, flow.md says skip straight from code.
    result = { ...vacancy, applyChannelRating, fitDecision: "skip", skipReason: "stack", tieBreakScore };
  } else if (missingMustHave.length > 0) {
    // Only the must-have check failed, and not all of it — borderline case,
    // deferred to Stage 3.5 (not implemented here). fitDecision is
    // deliberately left unset: it isn't final yet.
    result = { ...vacancy, applyChannelRating, needsLlmReview: true, missingMustHave, tieBreakScore };
  } else {
    result = { ...vacancy, applyChannelRating, fitDecision: "pass", tieBreakScore };
  }

  // --channel: only evaluated for immediate passes. flow.md frames this as
  // influencing which vacancies count toward quota N, not as another hard
  // fit field — needsLlmReview candidates get their final fitDecision from
  // Stage 3.5 first, so channel filtering for them belongs there too.
  const channelThreshold = resolveChannelThreshold(criteria.channel);
  if (channelThreshold !== undefined && result.fitDecision === "pass") {
    const { min, max } = applyChannelRating;
    if (min === undefined) {
      result.channelDecision = "unknown";
    } else if (min >= channelThreshold) {
      result.channelDecision = "pass";
    } else {
      result.channelDecision = "skip";
      // The known range straddles the threshold — this vacancy might
      // actually qualify (e.g. onsite rating could be 1, not 0), but Stage
      // 2's signal can't tell. Flagged rather than silently guessed either
      // way (see flow.md's "don't lower the bar" principle).
      result.channelUncertain = max !== undefined && max >= channelThreshold;
    }
  }

  return result;
}

export {
  SENIORITY_LEVELS,
  DEFAULT_STACK_SYNONYMS,
  CHANNEL_NAMES,
  matchStack,
  matchesSeniority,
  matchesLocation,
  matchesEmploymentType,
  extractSalaryMax,
  matchesSalary,
  applyChannelRatingRange,
  resolveChannelThreshold,
  evaluateFit,
};

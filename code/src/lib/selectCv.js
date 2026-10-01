// Stage 4 (Select CV) — deterministic skill-overlap CV selection from a
// fixed set under `cv/`. See docs/flow.md ("Stage 4 — Select CV") for the
// full spec this implements.
//
// No generation/tailoring here by design (flow.md, 2026-09-24 decision) —
// this module only parses each track's `## Skills`/`## Core Skills` section
// and scores its overlap against the vacancy's must-have+nice-to-have
// stack, reusing Stage 3's own keyword/synonym matcher (matchStack).

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { matchStack, termRegex, DEFAULT_STACK_SYNONYMS } from "./linkedinFit.js";

// A title saying "Frontend"/"React" is a near-certain signal on its own —
// much stronger than one more stack keyword matching the CV's skill list.
// Keyed by the real track ids this repo currently has under `cv/`; a track
// with no entry here (or a title that signals none of them) just falls
// through to pure skill-overlap scoring, see selectCv(). Override/extend
// via --title-signals <file.json>, same pattern as Stage 3's --synonyms.
const DEFAULT_TRACK_TITLE_SIGNALS = {
  frontend: ["frontend", "front-end", "front end", "react", "angular", "vue", "ui developer", "ui engineer"],
  backend: ["backend", "back-end", "back end", "node", "api developer"],
  aws: ["aws", "cloud engineer", "devops", "sre", "platform engineer", "infrastructure engineer"],
  full_stack: ["full stack", "full-stack", "fullstack"],
};

function hasTitleSignal(trackId, title, titleSignals) {
  const terms = titleSignals[trackId];
  if (!terms?.length || !title) return false;
  return terms.some((term) => termRegex(term).test(title));
}

const SKILLS_HEADING = /^#{1,6}\s*(core\s+)?skills\s*$/i;
const HEADING = /^#{1,6}\s/;
const BULLET = /^[-*]\s+/;

// flow.md: "`## Skills` — формат рядка: `Категорія: скіл, скіл, скіл`" — one
// bullet per category. A bullet's skill list sometimes line-wraps in the
// source .md (long category, e.g. cv/frontend's "Cloud & DevOps" line) —
// continuation lines are rejoined onto the bullet before splitting on ",",
// so the wrap point never fuses two skills together.
function parseCvSkills(markdown) {
  const lines = markdown.split(/\r?\n/);
  const headingIdx = lines.findIndex((line) => SKILLS_HEADING.test(line.trim()));
  if (headingIdx === -1) return [];

  const bullets = [];
  let current = null;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (HEADING.test(line.trim())) break;
    if (!line.trim()) continue;
    if (BULLET.test(line.trim())) {
      if (current) bullets.push(current);
      current = line.trim().replace(BULLET, "");
    } else if (current) {
      current += ` ${line.trim()}`;
    }
  }
  if (current) bullets.push(current);

  const skills = [];
  for (const bullet of bullets) {
    const withoutBold = bullet.replace(/\*\*/g, "");
    const colonIdx = withoutBold.indexOf(":");
    const skillsPart = colonIdx === -1 ? withoutBold : withoutBold.slice(colonIdx + 1);
    for (const skill of skillsPart.split(",")) {
      const trimmed = skill.trim();
      if (trimmed) skills.push(trimmed);
    }
  }
  return skills;
}

// Discovers CV tracks from `cv/` — any subdirectory containing a `cv.md`
// (case-insensitive filename) is a track; its id is the directory name.
// Not hardcoded to frontend/backend/aws/full_stack — flow.md leaves "does
// Stage 0 gate require all 4 tracks present" as an open question, so this
// just works with whatever tracks actually exist on disk.
async function discoverCvTracks(cvDir) {
  const entries = await readdir(cvDir, { withFileTypes: true });
  const tracks = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(cvDir, entry.name);
    const files = await readdir(dir);
    const cvFile = files.find((f) => f.toLowerCase() === "cv.md");
    if (!cvFile) continue;
    const pdfFile = files.find((f) => f.toLowerCase().endsWith(".pdf"));
    const markdown = await readFile(path.join(dir, cvFile), "utf8");
    tracks.push({
      id: entry.name,
      skills: parseCvSkills(markdown),
      pdfPath: pdfFile ? path.join(dir, pdfFile) : undefined,
    });
  }
  return tracks;
}

/**
 * Stage 4 — Select CV for one Stage 3 `fitDecision: "pass"` vacancy.
 * See docs/flow.md ("Stage 4 — Select CV") for the rubric this implements,
 * and its Open questions entry on title-based tie-break specifically.
 *
 * Vacancy title is the primary signal, skill overlap the secondary one —
 * a title naming exactly one track ("Frontend Engineer", or even just
 * "React Developer") decides outright, on the premise that a title calling
 * out a stack/role this explicitly is a far stronger signal than one more
 * keyword matching a CV's skill list. Skill overlap only breaks ties: when
 * the title names several tracks at once (a mixed-stack title) or none at
 * all.
 *
 * @param {object[]} tracks - from discoverCvTracks()
 * @param {string[]} targetStack - vacancy's must-have + nice-to-have stack (Stage 3 criteria)
 * @param {object} [options]
 * @param {object} [options.synonyms] - same synonym table Stage 3 used, see DEFAULT_STACK_SYNONYMS
 * @param {string} [options.fallbackId] - track id used when neither title nor skills decide it
 * @param {string} [options.title] - vacancy title, matched against options.titleSignals
 * @param {object} [options.titleSignals] - {trackId: [phrase, ...]}, see DEFAULT_TRACK_TITLE_SIGNALS
 * @returns {object} { selectedCv, cvPath, cvMatchScore, cvScores, titleMatches, decidedBy }
 */
function selectCv(tracks, targetStack, options = {}) {
  const {
    synonyms = DEFAULT_STACK_SYNONYMS,
    fallbackId = "full_stack",
    title = "",
    titleSignals = DEFAULT_TRACK_TITLE_SIGNALS,
  } = options;

  const cvScores = {};
  for (const track of tracks) {
    cvScores[track.id] = matchStack(track.skills.join(", "), targetStack, synonyms).matched.length;
  }

  const titleMatches = tracks.filter((t) => hasTitleSignal(t.id, title, titleSignals));

  let winner;
  let decidedBy;
  if (titleMatches.length === 1) {
    // Title alone names exactly one track — outright winner, regardless of
    // its skill-overlap score (even zero: a title this explicit outranks it).
    winner = titleMatches[0];
    decidedBy = "title";
  } else {
    // Mixed-stack title (several tracks signaled) narrows the tie-break
    // pool to just those; no title signal at all falls back to every track.
    const candidates = titleMatches.length > 1 ? titleMatches : tracks;
    const maxScore = Math.max(0, ...candidates.map((t) => cvScores[t.id]));
    const topTracks = candidates.filter((t) => cvScores[t.id] === maxScore);
    if (maxScore === 0 || topTracks.length !== 1) {
      winner = tracks.find((t) => t.id === fallbackId);
      decidedBy = "fallback";
    } else {
      winner = topTracks[0];
      decidedBy = "skills";
    }
  }

  if (!winner) {
    throw new Error(
      `No CV track selected and fallback "${fallbackId}" not found among tracks: ${tracks.map((t) => t.id).join(", ")}`,
    );
  }

  return {
    selectedCv: winner.id,
    cvPath: winner.pdfPath,
    cvMatchScore: cvScores[winner.id],
    cvScores,
    titleMatches: titleMatches.map((t) => t.id),
    decidedBy,
  };
}

export { parseCvSkills, discoverCvTracks, selectCv, DEFAULT_TRACK_TITLE_SIGNALS };

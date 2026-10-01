#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverCvTracks, selectCv, DEFAULT_TRACK_TITLE_SIGNALS } from "./lib/selectCv.js";
import { DEFAULT_STACK_SYNONYMS } from "./lib/linkedinFit.js";

const DEFAULT_CV_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "cv");

const USAGE = `Usage: node src/stage4-cli.js [--input <vacancies.json>] --must-have <skills> [options]

Reads Stage 3 vacancies either from --input <file> or piped stdin (JSON array).
  node src/stage3-cli.js ... | node src/stage4-cli.js --must-have react,typescript

Only vacancies with fitDecision "pass" get a CV selected — everything else is
passed through unchanged (same convention as Stage 3's own output).

Vacancy title is checked first: a title naming exactly one CV track (e.g.
"Frontend Engineer", or just "React Developer") picks that track outright.
Skill overlap only breaks ties — a mixed-stack title, or no title signal at
all.

Options:
  --input <file>          read vacancies from this JSON file instead of stdin
  --must-have <skills>    comma-separated must-have stack keywords (same list given to Stage 3)
  --nice-to-have <skills> comma-separated nice-to-have stack keywords (same list given to Stage 3)
  --synonyms <file>       JSON file of {skill: [synonym, ...]}, merged over the built-in defaults
  --title-signals <file>  JSON file of {trackId: [titlePhrase, ...]}, merged over the built-in defaults
  --cv-dir <dir>          directory of CV tracks (default: ${DEFAULT_CV_DIR})
  --fallback <track>      track id used when neither title nor skills decide it (default: full_stack)
  --help                  show this message
`;

function splitList(value) {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case "--input":
        args.input = next();
        break;
      case "--must-have":
        args.mustHave = splitList(next());
        break;
      case "--nice-to-have":
        args.niceToHave = splitList(next());
        break;
      case "--synonyms":
        args.synonymsFile = next();
        break;
      case "--title-signals":
        args.titleSignalsFile = next();
        break;
      case "--cv-dir":
        args.cvDir = next();
        break;
      case "--fallback":
        args.fallback = next();
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function loadVacancies(args) {
  let raw;
  if (args.input) {
    raw = await readFile(args.input, "utf8");
  } else if (!process.stdin.isTTY) {
    raw = await readStdin();
  } else {
    throw new Error(`No --input file given and no piped stdin detected.\n\n${USAGE}`);
  }

  const data = JSON.parse(raw);
  if (!Array.isArray(data)) throw new Error("Input must be a JSON array of Stage 3 vacancies");
  return data;
}

async function loadSynonyms(args) {
  if (!args.synonymsFile) return undefined;
  const raw = await readFile(args.synonymsFile, "utf8");
  return { ...DEFAULT_STACK_SYNONYMS, ...JSON.parse(raw) };
}

async function loadTitleSignals(args) {
  if (!args.titleSignalsFile) return undefined;
  const raw = await readFile(args.titleSignalsFile, "utf8");
  return { ...DEFAULT_TRACK_TITLE_SIGNALS, ...JSON.parse(raw) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(USAGE);
    return;
  }

  const mustHave = args.mustHave ?? [];
  const niceToHave = args.niceToHave ?? [];
  if (mustHave.length === 0 && niceToHave.length === 0) {
    throw new Error(`--must-have and/or --nice-to-have is required (same stack given to Stage 3).\n\n${USAGE}`);
  }
  const targetStack = [...mustHave, ...niceToHave];

  const vacancies = await loadVacancies(args);
  const synonyms = await loadSynonyms(args);
  const titleSignals = await loadTitleSignals(args);
  const cvDir = args.cvDir ?? DEFAULT_CV_DIR;
  const fallbackId = args.fallback ?? "full_stack";

  const tracks = await discoverCvTracks(cvDir);
  if (tracks.length === 0) {
    throw new Error(`No CV tracks found under ${cvDir} (expected subdirectories containing a cv.md)`);
  }

  const results = vacancies.map((vacancy) => {
    if (vacancy.fitDecision !== "pass") return vacancy;
    const { selectedCv, cvPath, cvMatchScore, cvScores, titleMatches, decidedBy } = selectCv(tracks, targetStack, {
      synonyms,
      fallbackId,
      title: vacancy.title,
      titleSignals,
    });
    return { ...vacancy, selectedCv, cvPath, cvMatchScore, cvScores, titleMatches, decidedBy };
  });

  console.log(JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});

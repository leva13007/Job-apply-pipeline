#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { evaluateFit, DEFAULT_STACK_SYNONYMS } from "./lib/linkedinFit.js";

const USAGE = `Usage: node src/stage3-cli.js [--input <vacancies.json>] [criteria flags]

Reads Stage 2 vacancies either from --input <file> or piped stdin (JSON array).
  node src/cli.js ... | node src/stage2-cli.js | node src/stage3-cli.js --must-have react,typescript

Options:
  --input <file>             read vacancies from this JSON file instead of stdin
  --seniority <levels>       comma-separated target LinkedIn seniority value(s),
                              e.g. "Mid-Senior level,Director"
  --seniority-adjacent       allow +/-1 seniority level as a match (default: exact only)
  --location <keywords>      comma-separated location keyword(s), substring match
  --employment-type <value>  e.g. "Full-time"
  --salary-min <number>      minimum acceptable salary (best-effort, see docs/flow.md)
  --must-have <skills>       comma-separated must-have stack keywords
  --nice-to-have <skills>    comma-separated nice-to-have stack keywords (tie-break, not a gate)
  --synonyms <file>          JSON file of {skill: [synonym, ...]}, merged over the built-in defaults
  --channel <rating|name>    minimum apply-channel rating (0-4) or name
                              (easy-apply/linkedin-apply/external-ats/company-site/meet-the-hiring-team)
  --help                     show this message
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
      case "--seniority":
        args.seniority = splitList(next());
        break;
      case "--seniority-adjacent":
        args.seniorityAdjacent = true;
        break;
      case "--location":
        args.locations = splitList(next());
        break;
      case "--employment-type":
        args.employmentType = next();
        break;
      case "--salary-min":
        args.salaryMin = Number(next());
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
      case "--channel":
        args.channel = next();
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
  if (!Array.isArray(data)) throw new Error("Input must be a JSON array of Stage 2 vacancies");
  return data;
}

async function loadSynonyms(args) {
  if (!args.synonymsFile) return undefined;
  const raw = await readFile(args.synonymsFile, "utf8");
  return { ...DEFAULT_STACK_SYNONYMS, ...JSON.parse(raw) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(USAGE);
    return;
  }

  const vacancies = await loadVacancies(args);
  const synonyms = await loadSynonyms(args);

  const criteria = {
    seniority: args.seniority,
    seniorityAdjacent: args.seniorityAdjacent,
    locations: args.locations,
    employmentType: args.employmentType,
    salaryMin: args.salaryMin,
    mustHave: args.mustHave,
    niceToHave: args.niceToHave,
    synonyms,
    channel: args.channel,
  };

  const results = vacancies.map((vacancy) => evaluateFit(vacancy, criteria));
  console.log(JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});

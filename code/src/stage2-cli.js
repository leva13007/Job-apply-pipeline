#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { extractVacancies } from "./lib/linkedinVacancy.js";

const USAGE = `Usage: node src/stage2-cli.js [--input <candidates.json>] [--delay <ms>]

Reads Stage 1 candidates either from --input <file> or piped stdin (JSON array).
  node src/cli.js ... | node src/stage2-cli.js

Options:
  --input <file>   read candidates from this JSON file instead of stdin
  --delay <ms>     delay between sequential vacancy fetches (default 2000)
  --help           show this message
`;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case "--input":
        args.input = next();
        break;
      case "--delay":
        args.delayMs = Number(next());
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

async function loadCandidates(args) {
  let raw;
  if (args.input) {
    raw = await readFile(args.input, "utf8");
  } else if (!process.stdin.isTTY) {
    raw = await readStdin();
  } else {
    throw new Error(`No --input file given and no piped stdin detected.\n\n${USAGE}`);
  }

  const data = JSON.parse(raw);
  if (!Array.isArray(data)) throw new Error("Input must be a JSON array of Stage 1 candidates");
  return data;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(USAGE);
    return;
  }

  const candidates = await loadCandidates(args);
  const results = await extractVacancies(candidates, { delayMs: args.delayMs });
  console.log(JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});

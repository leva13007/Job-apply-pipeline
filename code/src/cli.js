#!/usr/bin/env node
import { searchJobs } from "./lib/linkedinSearch.js";

const USAGE = `Usage: node src/cli.js --keywords <text> --location <text> --count <N> [options]

Required:
  --keywords <text>       job title / skill to search for
  --location <text>       search location (real place name, not "Remote")
  --count, -n <N>         number of unique candidates to collect

Options:
  --recency <seconds>     only jobs posted within this window (f_TPR)
  --work-type <value>     onsite|remote|hybrid or 1|2|3 (f_WT)
  --max-pages <N>         pagination safety cap (default 50)
  --help                  show this message
`;

function parseArgs(argv) {
  const args = { maxPages: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case "--keywords":
        args.keywords = next();
        break;
      case "--location":
        args.location = next();
        break;
      case "--count":
      case "-n":
        args.count = Number(next());
        break;
      case "--recency":
        args.recencySeconds = Number(next());
        break;
      case "--work-type":
        args.workType = next();
        break;
      case "--max-pages":
        args.maxPages = Number(next());
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

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(USAGE);
    return;
  }
  if (!args.keywords || !args.location || !args.count) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  const results = await searchJobs({
    keywords: args.keywords,
    location: args.location,
    count: args.count,
    recencySeconds: args.recencySeconds,
    workType: args.workType,
    ...(args.maxPages ? { maxPages: args.maxPages } : {}),
  });

  console.log(JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});

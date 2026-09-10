# job-pipeline — Stage 1 (Search)

Node.js implementation of Stage 1 from [`../docs/flow.md`](../docs/flow.md): scrapes LinkedIn's public "guest" job search endpoint and returns a deduplicated list of job candidates.

**Scope of this implementation:** API path only. No browser-automation fallback (`--method browser`), no dedup against the applications tracker, no fit/channel filtering — those depend on pipeline stages that don't exist yet (Stage 3, Stage 7). See "Limitations" below.

## Requirements

- Node.js >= 18 (uses the built-in `fetch`)
- No external dependencies

## CLI usage

```bash
cd code
node src/cli.js --keywords "software engineer" --location "United Kingdom" --count 10
```

### Options

| flag | required | description |
|---|---|---|
| `--keywords <text>` | yes | job title / skill to search for |
| `--location <text>` | yes | a real place name (e.g. `"United Kingdom"`) — literal `"Remote"` does **not** filter by LinkedIn, see note below |
| `--count`, `-n <N>` | yes | number of unique candidates to collect |
| `--recency <seconds>` | no | only jobs posted within this window, e.g. `604800` for the last 7 days (`f_TPR`) |
| `--work-type <value>` | no | `onsite` \| `remote` \| `hybrid` (or `1`\|`2`\|`3`) (`f_WT`) |
| `--max-pages <N>` | no | pagination safety cap (default `50`) |
| `--help` | no | print usage |

Result is printed to stdout as JSON.

### Example

```bash
node src/cli.js \
  --keywords "backend engineer" \
  --location "United Kingdom" \
  --work-type remote \
  --recency 604800 \
  --count 5
```

```json
[
  {
    "id": 1,
    "title": "Backend Engineer",
    "company": "Acme Ltd",
    "companyUrl": "https://www.linkedin.com/company/acme?trk=...",
    "location": "London, England, United Kingdom",
    "date": "2026-09-08",
    "url": "https://uk.linkedin.com/jobs/view/backend-engineer-at-acme-4436080809"
  }
]
```

`url` is already stripped of tracking query params (`position`, `pageNum`, `refId`, `trackingId`, ...) — this is the stable identifier used for dedup and for later pipeline stages.

Redirect the output to a file if you need it for later stages:

```bash
node src/cli.js --keywords "backend engineer" --location "United Kingdom" --count 10 > candidates.json
```

## Programmatic usage

```js
import { searchJobs } from "./src/lib/linkedinSearch.js";

const candidates = await searchJobs({
  keywords: "backend engineer",
  location: "United Kingdom",
  workType: "remote",     // optional: "onsite" | "remote" | "hybrid" | 1 | 2 | 3
  recencySeconds: 604800, // optional
  count: 10,
});

console.log(candidates);
```

## Notes / gotchas

- **`location: "Remote"` does not work as a filter.** LinkedIn ignores it as a special value and returns geographically mixed results. Use a real place (e.g. `"United Kingdom"`) plus `workType: "remote"` instead — see `flow.md` Stage 1.
- **Rate limiting.** This hits LinkedIn's public guest endpoint without authentication. Requests are throttled by design (custom headers, 15s timeout, retry/backoff on `429`/`5xx`, and detection of LinkedIn's "soft" rate-limit — an HTTP 200 with a tiny `authwall` redirect body instead of real content). Keep request volume low; this is meant for personal use, not bulk scraping (ToS caveat, see `flow.md`).
- Within a single run, results are deduplicated by stripped `url`. Deduplication against the applications tracker (Stage 7) is not implemented here — it happens in a later stage once the tracker exists.

## Limitations / not implemented here

See `../docs/flow.md` Stage 1 for full context. Not covered by this code yet:

- `--method browser` fallback (browser automation)
- Dedup against `applications.csv` (tracker doesn't exist yet)
- Reading search criteria from `user_info.md` (onboarding isn't implemented yet) — this CLI takes criteria as flags instead
- Pagination driven by post-fit quota (Stage 3 fit-matching doesn't exist yet) — this CLI just paginates until `count` raw candidates are collected

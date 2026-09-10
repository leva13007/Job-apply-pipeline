# job-pipeline — Stage 1 & 2

Node.js implementation of Stage 1 (Search) and Stage 2 (Extract vacancy data) from [`../docs/flow.md`](../docs/flow.md).

- **Stage 1** scrapes LinkedIn's public "guest" job search endpoint and returns a deduplicated list of job candidates.
- **Stage 2** takes those candidates and fetches each vacancy's public page directly to extract full details (description, seniority/employment type, apply channel, recruiter contact, etc).

**Scope of this implementation:** API path only. No browser-automation fallback (`--method browser`), no dedup against the applications tracker, no fit/channel filtering — those depend on pipeline stages that don't exist yet (Stage 3, Stage 7). See each stage's "Limitations" section below.

## Requirements

- Node.js >= 18 (uses the built-in `fetch`)
- No external dependencies

## Stage 1 — Search

### CLI usage

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

### Programmatic usage

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

### Notes / gotchas

- **`location: "Remote"` does not work as a filter.** LinkedIn ignores it as a special value and returns geographically mixed results. Use a real place (e.g. `"United Kingdom"`) plus `workType: "remote"` instead — see `flow.md` Stage 1.
- **Rate limiting.** This hits LinkedIn's public guest endpoint without authentication. Requests are throttled by design (custom headers, 15s timeout, retry/backoff on `429`/`5xx`, and detection of LinkedIn's "soft" rate-limit — an HTTP 200 with a tiny `authwall` redirect body instead of real content). Keep request volume low; this is meant for personal use, not bulk scraping (ToS caveat, see `flow.md`).
- Within a single run, results are deduplicated by stripped `url`. Deduplication against the applications tracker (Stage 7) is not implemented here — it happens in a later stage once the tracker exists.

### Limitations / not implemented here

See `../docs/flow.md` Stage 1 for full context. Not covered by this code yet:

- `--method browser` fallback (browser automation)
- Dedup against `applications.csv` (tracker doesn't exist yet)
- Reading search criteria from `user_info.md` (onboarding isn't implemented yet) — this CLI takes criteria as flags instead
- Pagination driven by post-fit quota (Stage 3 fit-matching doesn't exist yet) — this CLI just paginates until `count` raw candidates are collected

## Stage 2 — Extract vacancy data

Takes Stage 1 candidates and fetches each vacancy's public `/jobs/view/...` page directly (no separate API) to extract full details: description, job-criteria fields, apply channel (onsite/offsite), recruiter contact, and a best-effort active/closed flag.

### CLI usage

Accepts candidates either piped from Stage 1 or from a JSON file:

```bash
# pipe directly from Stage 1
node src/cli.js --keywords "backend engineer" --location "United Kingdom" --count 5 | node src/stage2-cli.js

# or from a saved file
node src/cli.js --keywords "backend engineer" --location "United Kingdom" --count 5 > candidates.json
node src/stage2-cli.js --input candidates.json
```

#### Options

| flag | required | description |
|---|---|---|
| `--input <file>` | no | read candidates from this JSON file instead of stdin |
| `--delay <ms>` | no | delay between sequential vacancy fetches (default `2000`) |
| `--help` | no | print usage |

If neither `--input` nor piped stdin is given, the CLI fails fast with a usage message instead of hanging.

### Example

```bash
node src/cli.js --keywords "backend engineer" --location "United Kingdom" --count 1 | node src/stage2-cli.js
```

```json
[
  {
    "id": 1,
    "url": "https://uk.linkedin.com/jobs/view/senior-software-engineer-python-at-admiral-money-4459422275",
    "date": "2026-08-28",
    "title": "Senior Software Engineer - Python",
    "company": "Admiral Money",
    "companyUrl": "https://uk.linkedin.com/company/admiral-money?trk=public_jobs_topcard-org-name",
    "location": "Cardiff, Wales, United Kingdom",
    "description": "We are looking for a Senior Software Engineer - Python to join our team...\n\nRequired Skills/Experience\n\n- Significant professional experience with Python\n- Use of AWS (or other cloud platform providers)\n...",
    "seniority": "Not Applicable",
    "employmentType": "Full-time",
    "jobFunction": "Engineering and Information Technology",
    "industries": "Financial Services, IT Services and IT Consulting, and Insurance",
    "isActive": true,
    "applyChannel": "offsite",
    "applyTrackingControlName": "public_jobs_contextual-sign-in-modal_ssr-ui-lib-outlet-button",
    "hasOffsiteIcon": true,
    "isMeetTheHiringTeam": false,
    "fetchStatus": "ok"
  }
]
```

(`description` truncated above for readability — the real output preserves full text with line breaks.)

### Programmatic usage

```js
import { extractVacancy, extractVacancies } from "./src/lib/linkedinVacancy.js";

const vacancy = await extractVacancy({ id: 1, url: "https://uk.linkedin.com/jobs/view/..." });

const vacancies = await extractVacancies(candidates, { delayMs: 2000 });
```

### Output schema

```ts
{
  id: number, url: string, date?: string,               // carried from Stage 1
  title?: string, company?: string, companyUrl?: string, location?: string,  // Stage 2 override, Stage 1 fallback
  description?: string,                                  // newline-preserving text
  seniority?: string, employmentType?: string, jobFunction?: string, industries?: string,
  isActive: boolean,                                      // best-effort
  applyChannel?: "onsite" | "offsite",
  applyTrackingControlName?: string,
  hasOffsiteIcon: boolean,
  applyUrl?: string, atsHost?: string,                    // best-effort/TBD
  recruiterContact?: { name?: string, title?: string, profileUrl?: string },
  isMeetTheHiringTeam: boolean,
  fetchStatus: "ok" | "not_found" | "error",
  fetchError?: string,                                    // only present when fetchStatus === "error"
}
```

### Notes / gotchas

- **Rate limiting.** Vacancies are fetched **sequentially**, not concurrently, with a configurable delay (`--delay`, default 2000ms) between requests — `flow.md`'s empirical finding is that ~7–10 rapid sequential requests trigger the same soft-rate-limit/authwall response as Stage 1. This default is a starting point, not a proven-safe rate (see `flow.md` Open Questions). Per-vacancy fetch failures (retries exhausted) don't abort the whole batch — they come back as `fetchStatus: "error"`.
- **`applyChannel` signal location varies.** For onsite applies, `data-tracking-control-name` on the `#topbar-apply` button is the signal directly. For offsite applies, LinkedIn sometimes wraps the button in a sign-in modal instead — in that case the button's own attribute is a generic modal-trigger value, and the real signal is on a sibling element's `data-impression-id`. This implementation checks both locations (see `flow.md` Stage 2 for the empirical detail).

### Limitations / not implemented here

See `../docs/flow.md` Stage 2 for full context. Not covered by this code yet:

- **`isActive`** is a plain-text phrase search (`"no longer accepting applications"`), not a verified CSS-selector-based banner detection — `flow.md` has no confirmed selector for this. Absence of the phrase is not proof the job is open.
- **`applyUrl`/`atsHost`** are best-effort and often `undefined` — `#topbar-apply` is frequently a `<button>` with JS-driven navigation rather than a direct `<a href>`, in which case there's no exploitable signal from an unauthenticated fetch. No maintained ATS domain allowlist (Greenhouse/Lever/Workday/etc.) is included.
- **Apply-channel rating precision:** only the coarse onsite/offsite split (ratings {0,1} vs {2,3}) and the rating-4 "Meet the hiring team" signal are available. Distinguishing 0 vs 1 (Easy Apply vs. plain LinkedIn apply) and 2 vs 3 (external ATS vs. company site) is deferred to a future browser-automation step.
- **`location`** on the detail page uses a best-guess, unconfirmed selector (`topcard__flavor--bullet`) — falls back to the Stage 1 candidate's `location` if it doesn't parse.
- **`message-the-recruiter` block** (rating 4 / recruiter contact) was verified empirically on exactly one historical example (job ID `4458957079`); co-occurrence with offsite listings is unconfirmed.
- No browser-automation fallback, no fit-matching (Stage 3), no tracker/archive writes (Stage 7).

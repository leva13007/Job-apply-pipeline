# job-pipeline — Stage 1-4

Node.js implementation of Stage 1 (Search), Stage 2 (Extract vacancy data), Stage 3 (Match / fit) and Stage 4 (Select CV) from [`../docs/flow.md`](../docs/flow.md).

- **Stage 1** scrapes LinkedIn's public "guest" job search endpoint and returns a deduplicated list of job candidates.
- **Stage 2** takes those candidates and fetches each vacancy's public page directly to extract full details (description, seniority/employment type, apply channel, recruiter contact, etc).
- **Stage 3** takes Stage 2 vacancies plus match criteria and applies the deterministic hard-fit filters (seniority/location/employment type/salary/stack must-have), computes the apply-channel rating, and flags borderline stack cases for the (not-yet-implemented) Stage 3.5 LLM review.
- **Stage 4** takes Stage 3 vacancies with `fitDecision: "pass"` and picks one CV from the fixed, pre-written set under [`../cv/`](../cv) — the track whose `## Skills` section overlaps most with the vacancy's must-have/nice-to-have stack. No generation or rewriting; see `../docs/flow.md`'s 2026-09-24 decision note under Stage 4.

**Scope of this implementation:** API path only. No browser-automation fallback (`--method browser`), no dedup against the applications tracker, no `user_info.md` reading (criteria are passed as flags instead), no Stage 3.5 LLM review, no apply/tracking — those depend on pipeline stages that don't exist yet (onboarding, Stage 3.5, Stage 5+). See each stage's "Limitations" section below.

## Requirements

- Node.js >= 18 (uses the built-in `fetch`)
- No external dependencies

## Running the pipeline

Each stage reads JSON from stdin (or `--input <file>`) and writes JSON to stdout — nothing is saved to disk on its own. That gives two equivalent ways to chain stages:

**Piped end-to-end** — nothing touches disk, nothing to clean up:

```bash
node src/cli.js --keywords "backend engineer" --location "United Kingdom" --count 5 \
  | node src/stage2-cli.js \
  | node src/stage3-cli.js --must-have node,typescript --location "United Kingdom" \
  | node src/stage4-cli.js --must-have node,typescript
```

**Stage-by-stage, saving each stage's output with `>`** — slower to fetch again, but lets you re-run a later stage (e.g. Stage 3 with different `--must-have`/`--location`, or Stage 4 against an updated `cv/`) without re-hitting LinkedIn, and lets you inspect the intermediate JSON:

```bash
node src/cli.js --keywords "backend engineer" --location "United Kingdom" --count 5 > candidates.json
node src/stage2-cli.js --input candidates.json > vacancies.json
node src/stage3-cli.js --input vacancies.json --must-have node,typescript --location "United Kingdom" > fit.json
node src/stage4-cli.js --input fit.json --must-have node,typescript
```

Stage 4 needs the *same* `--must-have`/`--nice-to-have` list you gave Stage 3 — it isn't carried through the JSON, since Stage 3's output only keeps the per-vacancy match results, not the criteria that produced them.

You can also mix the two — e.g. pipe Stage 1 straight into Stage 2 but save *that* output for Stage 3:

```bash
node src/cli.js --keywords "backend engineer" --location "United Kingdom" --count 5 \
  | node src/stage2-cli.js > vacancies.json
node src/stage3-cli.js --input vacancies.json --must-have node,typescript
```

Each stage's own section below shows its specific flags; this section is just the hand-off pattern between them.

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

Redirect Stage 2's own output to a file if Stage 3 needs it later (e.g. to try several `--must-have`/`--location` combinations without re-fetching):

```bash
node src/stage2-cli.js --input candidates.json > vacancies.json
node src/stage3-cli.js --input vacancies.json --must-have react,typescript
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
- No browser-automation fallback, no tracker/archive writes (Stage 7).

## Stage 3 — Match / fit

Takes Stage 2 vacancies plus match criteria (passed as flags — `user_info.md` doesn't exist yet, see Limitations) and, per vacancy: runs the deterministic hard-fit filters, matches must-have/nice-to-have stack keywords, and computes the apply-channel rating. Vacancies that fail on anything other than must-have stack are skipped straight from code; vacancies whose *only* problem is a partial must-have miss get `needsLlmReview: true` instead — final judgment on those is Stage 3.5, which this repo doesn't implement.

### CLI usage

```bash
# pipe directly from Stage 1 -> Stage 2 -> Stage 3
node src/cli.js --keywords "backend engineer" --location "United Kingdom" --count 5 \
  | node src/stage2-cli.js \
  | node src/stage3-cli.js --must-have node,typescript --location "United Kingdom" --channel 2

# or from a saved Stage 2 file (see "Running the pipeline" above for how to produce vacancies.json)
node src/stage3-cli.js --input vacancies.json --seniority "Mid-Senior level" --must-have react,typescript
```

#### Options

| flag | required | description |
|---|---|---|
| `--input <file>` | no | read vacancies from this JSON file instead of stdin |
| `--seniority <levels>` | no | comma-separated target LinkedIn seniority value(s), e.g. `"Mid-Senior level,Director"` |
| `--seniority-adjacent` | no | allow ±1 seniority level as a match (default: exact match only) |
| `--location <keywords>` | no | comma-separated location keyword(s), substring match against Stage 2 `location` |
| `--employment-type <value>` | no | e.g. `"Full-time"` |
| `--salary-min <number>` | no | minimum acceptable salary — best-effort, see Notes below |
| `--must-have <skills>` | no | comma-separated must-have stack keywords |
| `--nice-to-have <skills>` | no | comma-separated nice-to-have stack keywords — tie-break score only, not a gate |
| `--synonyms <file>` | no | JSON file of `{skill: [synonym, ...]}`, merged over the built-in defaults |
| `--channel <rating\|name>` | no | minimum apply-channel rating (`0`-`4`) or name (`easy-apply`/`linkedin-apply`/`external-ats`/`company-site`/`meet-the-hiring-team`) |
| `--help` | no | print usage |

Any flag can be omitted — a criterion that isn't given simply isn't checked (never treated as a failure).

### Programmatic usage

```js
import { evaluateFit } from "./src/lib/linkedinFit.js";

const result = evaluateFit(vacancy, {
  seniority: ["Mid-Senior level"],
  locations: ["United Kingdom"],
  mustHave: ["node", "typescript"],
  niceToHave: ["docker"],
  channel: 2, // or "external-ats"
});
```

### Output schema

Stage 2's vacancy object, augmented with:

```ts
{
  applyChannelRating: { min: number, max: number },       // known-guaranteed 0-4 range, see Notes
  fitDecision?: "pass" | "skip",                            // absent while needsLlmReview is true
  skipReason?: "seniority" | "location" | "employmentType" | "salary" | "stack",
  needsLlmReview?: true,
  missingMustHave?: string[],                               // only when needsLlmReview
  tieBreakScore?: number,                                    // nice-to-have match count
  channelDecision?: "pass" | "skip" | "unknown",             // only when --channel given and fitDecision === "pass"
  channelUncertain?: boolean,                                 // true if the rating range straddles --channel's threshold
}
```

### Notes / gotchas

- **`applyChannelRating` is a range, not a number.** Stage 2's unauthenticated fetch only gives a coarse onsite/offsite split (`{0,1}` vs `{2,3}`) plus a reliable rating-4 signal — 0 vs 1 and 2 vs 3 aren't resolvable without a browser step (see `flow.md`). `--channel` filtering uses the range's guaranteed minimum, so it never lets a vacancy through it can't confirm; `channelUncertain: true` flags cases that might actually have qualified but couldn't be confirmed either way.
- **Seniority matching defaults to exact.** `flow.md` leaves "does `Mid-Senior level` satisfy a `Senior` search" as an open question — this implementation matches LinkedIn's own 6 enum values exactly unless `--seniority-adjacent` is passed (±1 level tolerance).
- **Salary extraction is a heuristic, not verified against real listings** (`flow.md` flags this as the one Stage 1-3 regex that hasn't been empirically checked). It scans `description` for money-like tokens and takes the largest as a proxy for "salary offered." No match found → the check is skipped, not failed.
- **Stack synonym table is a small starter list**, not sourced from anywhere canonical — pass `--synonyms <file.json>` to extend/override it.
- **`--location` is substring matching only** against Stage 2's `location` field — there's no `f_WT`/work-type signal on the Stage 2 vacancy object to combine it with (Stage 1's `--work-type` isn't carried through the pipeline yet).

### Limitations / not implemented here

See `../docs/flow.md` Stage 3 for full context. Not covered by this code yet:

- **Stage 3.5** (LLM review of borderline must-have cases) — `needsLlmReview: true` candidates stop here; nothing resolves their final `fitDecision`.
- **Reading criteria from `user_info.md`** — onboarding isn't implemented yet, same as Stage 1; this CLI takes criteria as flags instead.
- **Quota-aware pagination** — nothing here re-triggers Stage 1 when too few vacancies pass; this CLI just evaluates whatever list it's given.
- **Work-type (`f_WT`) combined with location** — not implemented, see Notes above.

## Stage 4 — Select CV

Takes Stage 3 vacancies and, for each one with `fitDecision: "pass"`, picks one CV from the fixed set under [`../cv/`](../cv) — no generation, no rewriting, no rendering (`flow.md`'s 2026-09-24 decision: tailoring per vacancy was dropped as not worth the complexity). Any other vacancy (`skip` or `needsLlmReview`) is passed through unchanged.

### How selection works

1. Every subdirectory of `cv/` containing a `cv.md` is a CV track (track id = directory name — not hardcoded to `frontend`/`backend`/`aws`/`full_stack`, see `flow.md` Open questions).
2. Each track's `## Skills` (or `## Core Skills`) section is parsed into a flat skill list — same `Category: skill, skill, skill` format as `../docs/user_data.md` specifies.
3. **Vacancy title decides first.** The title is checked against a per-track list of title phrases (`frontend` ← "frontend"/"react"/"angular"/..., `backend` ← "backend"/"node"/..., etc. — see `DEFAULT_TRACK_TITLE_SIGNALS` in `selectCv.js`). A title naming **exactly one** track wins outright — "React Developer" picks `frontend` even if nothing in `--must-have` happens to overlap its skill list. The premise (`flow.md`'s own open question on this): a title this explicit is a stronger signal than one more stack keyword.
4. **Skill overlap only breaks ties.** If the title names *several* tracks at once (a mixed-stack title like "Full Stack Engineer (React/Node)") or none at all, each candidate track's skill list is matched against the vacancy's `--must-have` + `--nice-to-have` stack using Stage 3's own keyword/synonym matcher (`matchStack` from `linkedinFit.js` — reused, not duplicated), and the highest-overlap track wins.
5. If that's still a tie, or nothing matched anything, it falls back to `--fallback` (default `full_stack`).

### CLI usage

```bash
# pipe directly from Stage 3
node src/stage3-cli.js --input vacancies.json --must-have react,typescript \
  | node src/stage4-cli.js --must-have react,typescript

# or from a saved Stage 3 file
node src/stage4-cli.js --input fit.json --must-have react,typescript --nice-to-have docker
```

#### Options

| flag | required | description |
|---|---|---|
| `--input <file>` | no | read vacancies from this JSON file instead of stdin |
| `--must-have <skills>` | one of these two | comma-separated must-have stack keywords — the same list given to Stage 3 |
| `--nice-to-have <skills>` | one of these two | comma-separated nice-to-have stack keywords — the same list given to Stage 3 |
| `--synonyms <file>` | no | JSON file of `{skill: [synonym, ...]}`, merged over the built-in defaults (same file you'd give Stage 3, for consistent matching) |
| `--title-signals <file>` | no | JSON file of `{trackId: [titlePhrase, ...]}`, merged over `DEFAULT_TRACK_TITLE_SIGNALS` |
| `--cv-dir <dir>` | no | directory of CV tracks (default: `../cv` relative to this package) |
| `--fallback <track>` | no | track id used on a tie or on zero matches anywhere (default: `full_stack`) |
| `--help` | no | print usage |

### Programmatic usage

```js
import { discoverCvTracks, selectCv } from "./src/lib/selectCv.js";

const tracks = await discoverCvTracks("../cv");
const result = selectCv(tracks, ["react", "typescript", "docker"], {
  title: "Senior React Developer", // optional — decides outright if it names exactly one track
});
```

### Output schema

Stage 3's vacancy object; vacancies with `fitDecision: "pass"` are augmented with:

```ts
{
  selectedCv: string,          // winning track id, e.g. "frontend"
  cvPath?: string,             // path to that track's already-rendered PDF
  cvMatchScore: number,        // winning track's skill-overlap count — for diagnostics (flow.md, Stage 8 summary)
  cvScores: Record<string, number>, // every track's skill-overlap count, for diagnosing ties/fallbacks
  titleMatches: string[],      // track ids the vacancy title alone signaled, [] if none
  decidedBy: "title" | "skills" | "fallback", // which rule actually picked the winner
}
```

### Notes / gotchas

- **Needs the same stack you gave Stage 3.** Stage 3's output doesn't carry its input criteria through — only the per-vacancy match results — so Stage 4 takes `--must-have`/`--nice-to-have` again rather than inferring them.
- **Title beats skill overlap on purpose.** A vacancy titled "Frontend Engineer" or just "React Developer" picks `frontend` even with a weak/zero stack overlap — `decidedBy: "title"` in the output marks exactly when this happened. `titleMatches` also shows when a *mixed* title (e.g. "Full Stack Engineer (React/Node)") signaled more than one track at once, in which case skill overlap still breaks the tie among those.
- **Skill parsing is line-wrap-safe.** A `cv.md` bullet that wraps onto a second physical line (e.g. a long `Cloud & DevOps:` list) is rejoined before splitting on `,`, so the wrap point can't fuse two skills together.
- **Matching reuses Stage 3's synonym table and matcher verbatim** (`matchStack`/`DEFAULT_STACK_SYNONYMS` from `linkedinFit.js`) — pass the same `--synonyms <file.json>` to both stages to keep them consistent.
- **Title signals are a small starter list**, keyed only by the track ids this repo actually has (`frontend`/`backend`/`aws`/`full_stack`) — a track with no entry in `DEFAULT_TRACK_TITLE_SIGNALS` just never wins on title alone. Pass `--title-signals <file.json>` to extend/override it.

### Limitations / not implemented here

See `../docs/flow.md` Stage 4 for full context. Not covered by this code yet:

- **Optional per-CV human review** (`flow.md`'s "N-й показ" parameter) — flagged there as TBD on exact flag name/syntax, so not implemented here.
- **Reading criteria from `user_info.md`** — same as Stages 1 and 3, criteria are flags instead.

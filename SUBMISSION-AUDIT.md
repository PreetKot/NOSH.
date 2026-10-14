# Final submission audit — October 13, 2026

**October 14 handoff update:** The author provided `https://github.com/PreetKot/NOSH..git`, authorized a push, and confirmed Codex should be disclosed as the AI tool. The README now contains the actual clone URL, explicit Codex/dependency disclosure, and a dated implementation timeline. The October 13 Git/readiness findings below are a historical snapshot, not the current publication status. Use `git ls-remote origin refs/heads/main` and `git rev-parse HEAD` to verify the final pushed version. Reviewer-specific access, Internshala submission, and the form response are not claimed.

The three-page `Full Stack Problem Statement-5.pdf` was reread. The implementation, dependency lockfile, seed source, example environment, tests, and README were inspected. The secondary spec and later guide did not override the PDF. Results below apply to the **current working tree**, which contains uncommitted bonus and shutdown-fix changes.

## Commands actually run

```sh
npm run verify:clean && npm run build && npm run test:all
git diff --check
git status --short
git branch --show-current
git rev-parse HEAD
git remote -v
git ls-files
git log --oneline --all
git check-ignore .env data/nosh.sqlite data/nosh.sqlite-wal dist/index.html test-results/desktop.png node_modules/playwright/package.json
```

The verification chain exited 0. Its clean setup ran `npm ci` with a fresh npm cache, copied `.env.example` to `.env` in an isolated directory, ran build, ran seed twice, and launched through `PORT=0 npm start`. It checked the page and all static assets for HTTP 200, compared GET to the supplied records, saved an edit, reseeded, and restarted the backend. Results: five initial inserts; zero inserts/five preserved on later seeds; edited values/version preserved. The build staged five assets. API tests: **14/14**. Core Chrome tests: **12/12**. Bonus checks: **6/6**. `git diff --check` passed.

The supplied JSON's SHA-256 remains `68a87775b5b09f17688f83d5730c5dc5bb845fe7dbe5a0188cc177c2ecf49b88`. No substitute assessment data was introduced.

## Required checks and submission readiness

| Required check | Evidence | Status |
| --- | --- | --- |
| Clean install/configuration/seed/start instructions work | `verify:clean`: fresh-cache npm install, sample env, seed, build, actual npm start and HTTP 200 checks | PASS locally; hosted clone/access unverified |
| Persistent unique dish IDs and required fields; seeded version 1 | Exact GET assertions against five supplied JSON records; SQLite primary key and persistent file | PASS |
| Reseeding creates no duplicates or edit resets | API test edits name/status/image/version in an isolated partial database, inserts four missing IDs, then reruns with zero inserts | PASS |
| Editing name/status remains local; Discard restores snapshot | Chrome test verifies both draft fields, unsaved indicator, unchanged GET, and zero PATCH requests before Save/after Discard | PASS |
| Successful Save uses explicit fields/version and adopts response | Chrome test checks exact payload, trimmed returned values, updated version, and cleared dirty state | PASS |
| Refresh and backend restart preserve saved values/version | API real-process restart, Chrome refresh/restart, and clean-setup restart assertions | PASS |
| Save disabled while pending | Chrome delayed-request test checks disabled Save and fields | PASS |
| Published empty/whitespace name rejected without mutation | API before/after equality and 400 assertions; Chrome draft correction/retry | PASS |
| Invalid stored image URL rejected without mutation | Isolated `tests/fixtures/invalid-image.json`, 400 HTTP/HTTPS error, unchanged GET/version; exact manual steps in README | PASS |
| PATCH required fields, types, identifier and expectedVersion validated | API missing/type/extra-field, positive safe integer, malformed ID/raw dot-segment, malformed JSON/body tests | PASS |
| Unknown dish returns 404 and clear JSON error | API unknown-ID test and README example | PASS |
| Compare-and-update is atomic under same-version concurrency | Two independent backend processes share SQLite; concurrent requests yield exactly one 200 and one 409, with version 2 | PASS |
| Stale save returns current dish/version and does not mutate winner | API conflict response and final GET exactly equal successful winning response | PASS |
| Two-tab conflict preserves newer save and losing draft | Chrome two-tab test retains both local fields/original version, shows current server state separately, and tests canceled/confirmed reload | PASS |
| Failed save retains editable draft and can retry | Chrome real stopped-backend test restarts backend and saves retained/revised draft; 400, JSON 500, and HTML error checks also pass | PASS |
| Loading, empty, fetch-error, broken-image, desktop/mobile states | Chrome state tests and 390px/1440px overflow assertions; screenshots generated; no uncaught browser errors | PASS in Chrome |
| Frontend, backend, dependency files, seed setup, README, safe example env included | `public/`, `server/`, `package.json`, lockfile, `scripts/seed.js`, supplied JSON, README, `.env.example` present; core files are tracked | PASS for presence; final changes need committing |
| No secrets or generated artifacts committed | Inspected all 21 tracked files and the sole commit; credential-pattern scan found no matches; no `.env`, SQLite, `node_modules`, `dist`, or test screenshots tracked; ignore checks passed | PASS for inspected commit/tree |
| README prerequisites/config/API examples/architecture/decision/limitations/verification | README inspected and commands above rerun, including isolated invalid-image instructions | PASS |
| Actual total time | Author reported 1–2 days, including preparation and review; README updated without converting to hours | PASS / author-confirmed |
| Complete AI/reuse disclosure | Codex/library/data use is recorded; any additional author-used tools/code remain pending; author asked | UNVERIFIED / needs author input |
| Final source version committed and identified | Branch is `main`; current HEAD predates bonus/fixes; modified files and three new bonus files remain uncommitted | FAIL readiness: commit final tree first |
| GitHub URL and reviewer access | `git remote -v` returned no configured remote; no GitHub URL/access verified | UNVERIFIED |
| Submission within three days of receipt | PDF specifies this deadline; actual receipt date is not recorded here | UNVERIFIED; confirm deadline in hiring conversation |
| Internshala submission contains URL, branch, final SHA, bonus, time | Draft below is prepared with missing values explicitly marked; nothing sent | UNVERIFIED / not submitted |
| Optional bonus | Three-second polling; six focused checks verify clean external updates, dirty draft protection, real outage recovery, timer/abort cleanup, and lifecycle restart | IMPLEMENTED / PASS |

No reproducible application defect was found in this final run. Documentation was updated to distinguish the tested working tree from the older commit and to cover both submission channels. The safe example environment is already committed. The assignment PDF, secondary spec, and prompt document remain preserved locally and untracked; they are not required application assets.

## Git identity and final commit

- Actual branch at audit: `main`.
- Actual current HEAD: `9ce130ebaccc03247222b7e80fa4195c099749ea`.
- **That SHA is not the final submission SHA.** It identifies the earlier core/audit commit, not the current bonus implementation or later fixes.
- No final SHA or repository URL is invented. Total time is author-confirmed as 1–2 days; complete the pending additional-reuse disclosure before creating the final commit.

From this directory, after reviewing the changes and completing those fields:

```sh
git add .gitignore .env.example package.json package-lock.json README.md SUBMISSION-AUDIT.md server public scripts data/dishes.json tests
git diff --cached --check
git diff --cached --stat
git commit -m "Finalize Nosh dashboard, polling bonus, and submission audit"
git branch --show-current
git rev-parse HEAD
```

Use the SHA printed by the last command. The explicit add list includes the new polling module/tests and excludes local runtime files. A GitHub repository/remote must then be created/configured and published under the author's explicit direction; this audit performs no publication. If private, obtain the hiring team's reviewer account and grant that account access before submission. Access has not been verified.

## Internshala message draft — not sent

```text
Nosh Full Stack Intern Assignment
Repository: https://github.com/PreetKot/NOSH.
Branch: main
Final commit SHA: [FINAL_SHA_AFTER_COMMIT]
Optional bonus: Implemented — three-second polling with draft protection.
Approximate total time spent: 1–2 days.
Setup, API examples, verification results, and AI/reuse disclosure are in the README.
```

Fill all placeholders only after the final commit/publication and the author's additional-reuse confirmation. Do not claim reviewer access until it is verified.

## Google Form preparation — not submitted

The later guide links to [this Google Form](https://forms.gle/zegbxdqL1awBEKzp6). A read-only GET followed the redirect and returned HTTP 200. The visible title was **Full Stack Assignment <> Nxtwave**; the page showed required name, email, and repository-URL inputs and respondent email collection. Its contents do not replace the PDF's explicit Internshala instruction.

| Form field / submission information | Prepared value |
| --- | --- |
| Name | `[YOUR_FULL_NAME]` |
| Email id | `[YOUR_CONTACT_EMAIL]` |
| Recorded respondent email | `[YOUR_SUBMISSION_ACCOUNT_EMAIL]` — confirm before submitting |
| Repo url | `https://github.com/PreetKot/NOSH.` |
| Branch — reference for accompanying Internshala message | `main` |
| Final SHA — reference for accompanying Internshala message | `[FINAL_SHA_AFTER_COMMIT]` |
| Bonus — reference for accompanying Internshala message | Implemented, three-second polling |
| Actual total effort — reference for accompanying Internshala message | 1–2 days, author-reported |
| AI/reuse — README disclosure | OpenAI Codex-assisted implementation/tests/docs; Nosh data/images, optional Google Fonts, Playwright |

The form page inspected did not expose separate branch/SHA/bonus/time fields. Keep that information in the PDF-required Internshala message and README; do not put non-URL metadata in the Repo url field. Form fields may change; review them before sending. No form response, chat message, access grant, or repository publication was performed.

# Nosh dish dashboard

A locally runnable dish editor with persistent SQLite storage, explicit Save/Discard, backend publication validation, and optimistic concurrency. The PDF is the source of requirements; `NOSH-assessment-spec.md` was used as a secondary checklist.

## Prerequisites and setup

- **Node.js 22.13 or newer**, with npm. Verified on Node 22.23.3 and npm 10.9.9 on macOS.
- A modern browser. Google Chrome is needed for the default browser test command, but not for running the application.
- No separate database installation, API keys, or required build step.

Clone the assignment repository, then enter it:

```sh
git clone https://github.com/PreetKot/NOSH..git nosh-dish-dashboard
cd nosh-dish-dashboard
```

From the repository root:

```sh
npm ci
cp .env.example .env
npm run seed
npm start
```

Open **http://127.0.0.1:3000**. Stop with Ctrl+C. `npm run dev` optionally restarts the backend when its source changes. Refresh the browser after frontend changes.

To build the frontend assets explicitly:

```sh
npm run build
```

The frontend uses native browser modules. This dependency-free build checks JavaScript syntax and stages `index.html`, `app.js`, `api.js`, `sync.js`, and `styles.css` in ignored `dist/`. No transpilation is needed. The local backend serves the source assets from `public/`, so normal development does not require a build. The staged frontend still needs the API on the same origin.

`.env` is optional; these are the defaults:

```dotenv
HOST=127.0.0.1
PORT=3000
DATABASE_PATH=./data/nosh.sqlite
SEED_FILE=./data/dishes.json
```

Relative paths are resolved from the repository root by the npm commands. The database directory is created automatically. Starting without seeding displays the empty state. The `.sqlite`, WAL, and SHM files are local runtime data and are excluded from Git. Do not delete them when restarting: they hold your saved values and versions. Node 22 prints an experimental SQLite warning; that is expected.

## Supplied seed data

`data/dishes.json` is the unmodified 852-byte JSON downloaded from the [Google Drive link in the PDF](https://drive.google.com/file/d/1iOh0c2r919zNUAz2FHqOSeZBjxjXglj1/view?usp=share_link) on October 13, 2026. It contains Jeera Rice, Paneer Tikka, Rabdi, Chicken Biryani, and Alfredo Pasta, with IDs `1` through `5` and the supplied image URLs.

SHA-256: `68a87775b5b09f17688f83d5730c5dc5bb845fe7dbe5a0188cc177c2ecf49b88`.

```sh
npm run seed
```

New rows start at version 1. The seed validates the whole file, then inserts in a transaction with `ON CONFLICT(dishId) DO NOTHING`. Existing names, images, statuses, and versions are all preserved. A second run on an unchanged database reports `0 inserted, 5 existing dishes preserved`. The checked-in JSON makes setup independent of future Drive access. No substitute assessment dishes were used. The intentionally invalid-image fixture under `tests/fixtures/` is separate test data and never part of the default seed.

## API contract

Both endpoints use the same origin as the frontend. Successful responses contain dish objects directly. JSON responses are not cached.

### List

```sh
curl -i http://127.0.0.1:3000/dishes
```

`200 OK` returns an array, or `[]` when empty:

```json
[
  {
    "dishId": "1",
    "dishName": "Jeera Rice",
    "imageUrl": "https://nosh-assignment.s3.ap-south-1.amazonaws.com/jeera-rice.jpg",
    "isPublished": true,
    "version": 1
  }
]
```

The example shows one entry; the initial supplied dataset returns five.

### Save

Read the current version first; the following example assumes dish `1` is still version 1:

```sh
curl -i -X PATCH http://127.0.0.1:3000/dishes/1 \
  -H 'Content-Type: application/json' \
  -d '{"dishName":"  Jeera Rice Special  ","isPublished":false,"expectedVersion":1}'
```

`200 OK`:

```json
{
  "dishId": "1",
  "dishName": "Jeera Rice Special",
  "imageUrl": "https://nosh-assignment.s3.ap-south-1.amazonaws.com/jeera-rice.jpg",
  "isPublished": false,
  "version": 2
}
```

Validation decisions:

- All three fields are required: string `dishName`, boolean `isPublished`, and positive safe integer `expectedVersion`. Unknown fields are rejected; `imageUrl` cannot be edited through PATCH.
- IDs contain 1–64 ASCII letters, digits, underscores, or hyphens, starting with a letter or digit. The supplied IDs are strings. Malformed/empty IDs return 400; a valid but missing ID returns 404. Routing preserves raw dot segments so identifiers such as `..` are rejected before URL normalization can change the endpoint.
- All saved names are trimmed. Unpublished dishes may have empty names. Published dishes require a non-empty trimmed name and a stored URL that parses with an HTTP/HTTPS protocol and hostname. URL reachability is not checked.
- JSON objects and `Content-Type: application/json` are required. Malformed JSON and bodies larger than 16 KiB return 400.
- Payload structure is checked first, then existence and version, then publication rules. A structurally valid stale request receives 409 with the current record.
- Every accepted PATCH increments version, including an explicit no-op. Publication always saves the supplied boolean; it never toggles a stored value.

### Errors

All application errors use `{ "error": { "code": "...", "message": "..." } }`. A conflict additionally includes a top-level `currentDish`.

| Status | Code | Example cause |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | Missing fields, wrong types/version/ID, invalid publication |
| 404 | `NOT_FOUND` | Unknown dish or route |
| 409 | `VERSION_CONFLICT` | `expectedVersion` differs from the stored version |
| 500 | `INTERNAL_ERROR` | Unexpected server/database failure; details logged on server |

Invalid publication (replace the version with the one returned by GET):

```sh
curl -i -X PATCH http://127.0.0.1:3000/dishes/1 \
  -H 'Content-Type: application/json' \
  -d '{"dishName":"   ","isPublished":true,"expectedVersion":2}'
```

```json
{"error":{"code":"VALIDATION_ERROR","message":"A published dish must have a non-empty name."}}
```

Unknown dish:

```sh
curl -i -X PATCH http://127.0.0.1:3000/dishes/unknown \
  -H 'Content-Type: application/json' \
  -d '{"dishName":"Rice","isPublished":false,"expectedVersion":1}'
```

```json
{"error":{"code":"NOT_FOUND","message":"Dish unknown was not found."}}
```

Repeating the successful version-1 save after version 2 exists returns `409 Conflict`:

```json
{
  "error": {
    "code": "VERSION_CONFLICT",
    "message": "A newer update exists. Reload the dish before saving again."
  },
  "currentDish": {
    "dishId": "1",
    "dishName": "Jeera Rice Special",
    "imageUrl": "https://nosh-assignment.s3.ap-south-1.amazonaws.com/jeera-rice.jpg",
    "isPublished": false,
    "version": 2
  }
}
```

Validation failures and conflicts roll back without changing any dish field or version.

## Architecture and design decision

```text
public/index.html + app.js + sync.js + styles.css
              │ same-origin fetch through public/api.js
              ▼
server/app.js   HTTP routing, JSON parsing, error responses
              ▼
server/database.js + errors.js   validation and transactional storage
              ▼
data/nosh.sqlite   persistent SQLite file
```

Plain JavaScript keeps this small assignment readable without a frontend framework or bundler. Node's built-in HTTP server, SQLite driver, and test runner avoid runtime dependencies. Playwright is a pinned development dependency for actual browser verification. The application has no external runtime JavaScript packages.

**Design decision: optimistic concurrency with an atomic SQLite transaction.** `BEGIN IMMEDIATE` acquires a database write lock before reading the stored dish. The same transaction checks the version and stored image, then executes `UPDATE ... WHERE dishId = ? AND version = ? RETURNING *`. The successful update increments the version; failures roll back. The SQL predicate explicitly guards the write. WAL and a five-second busy timeout accommodate the small local workload. This also protects updates made through independent backend processes sharing the file.

Each dish editor has three separate values: the last loaded/saved snapshot, an editable local draft, and an optional newer server `currentDish`. Save sends the version from the snapshot. Success replaces both snapshot and draft with the returned values. Failure leaves the draft intact. A 409 never advances its version or automatically retries; it blocks further saves while the conflict is unresolved. Reload fetches the latest record and requires confirmation that the draft will be lost. Discard restores the original snapshot, even after a conflict; with the bonus enabled, a later poll may refresh that now-clean dish. Fields and actions are disabled during a request to avoid editing a draft while its save is in flight.

Network/timeout, validation, and server failures appear next to the dish. The request helper safely catches non-JSON responses and validates the backend's array/dish shapes before replacing any state. A malformed success response preserves the draft and original snapshot. Even an unreadable 409 blocks stale retries and offers a confirmed reload; a failed reload preserves the draft and conflict details. Each dish's pending state and errors are independent. Explicit reload also refreshes the displayed image from the loaded snapshot. The dashboard includes loading, empty, retry, unsaved indicators, published/version metadata, responsive cards, labeled controls, and image-error fallbacks.

## Optional bonus: external updates

**Implemented with a three-second polling interval.** After the initial list loads successfully, `public/sync.js` reads the existing `GET /dishes` endpoint every 3,000 ms. No new API, server event channel, database schema, or runtime dependency is required.

- For a clean dish, a higher server version replaces its saved snapshot and form fields, including name, image, status, and version. The summary updates too.
- For a dirty dish, both draft fields and its original saved snapshot/version remain intact. A notice displays the newer saved dish/status/version separately. Reload requires confirmation that the draft will be discarded and fetches the latest server values. Discard restores the original snapshot; a subsequent poll may refresh that now-clean dish. An explicit stale Save still sends the original version and receives the normal 409; polling never submits or retries PATCH.
- Poll responses recheck the current draft at arrival. Older/equal versions are ignored, and a dish with Save or Reload in flight is skipped until a later poll, avoiding replacement during its request.
- A failed read keeps all current cards, drafts, and per-dish errors. A page-level message says live updates are temporarily unavailable. Polling continues and clears that message after a successful read. One request is allowed at a time; requests time out after ten seconds, so slow/disconnected requests do not accumulate.
- `pagehide` clears the timer and aborts an active poll. Late responses are ignored. `pageshow` restarts polling once, including after back/forward-cache restoration. This plain-JavaScript page has no framework unmount lifecycle; navigation/page teardown is its equivalent.

On a healthy foreground page, an external save normally appears within **0–3 seconds plus request time**. Slow requests, browser timer throttling, or a temporary disconnection can extend that delay. This trades immediate push delivery for one small GET every three seconds per open page and no connection infrastructure. Direct database edits are not part of the bonus contract. Only higher-version updates to loaded dishes are synchronized; creation/deletion is outside scope.

To reproduce with the dashboard open, read the current version and use it in PATCH (the example assumes dish `1` is version 1):

```sh
curl -s http://127.0.0.1:3000/dishes
curl -i -X PATCH http://127.0.0.1:3000/dishes/1 \
  -H 'Content-Type: application/json' \
  -d '{"dishName":"External API update","isPublished":false,"expectedVersion":1}'
```

Watch a clean card update without refreshing. Next, edit its name and switch locally, make another API update using the current server version, and wait for the newer-data notice: neither draft field nor the original displayed version should change. Cancel Reload to keep the draft or confirm it to load the newest saved values. Stop the backend with Ctrl+C, wait for the connection notice, restart with the same database/port, and watch polling recover without a page refresh. The focused tests exercise these flows and teardown:

```sh
npm run test:bonus
```

## Automated verification

```sh
npm run verify:clean
npm run build
npm test
npm run test:ui
npm run test:bonus
# Or all test suites in sequence:
npm run test:all
```

Browser tests use installed Google Chrome by default. For a machine without Chrome:

```sh
npx playwright install chromium
PLAYWRIGHT_CHROME_CHANNEL=chromium npm run test:ui
```

Tests use fresh temporary SQLite files and terminate their backend processes; they do not edit the default database. Browser tests deliberately abort external image/font requests so functional checks do not rely on third-party availability. Layout screenshots are written to ignored `test-results/desktop.png` and `test-results/mobile.png`.

`npm run verify:clean` copies only application source, dependency files, the example environment, tests, and the supplied JSON into a temporary directory. It copies no `node_modules`, database, real `.env`, or npm cache. It runs an actual `npm ci` with a fresh npm cache, copies `.env.example` to `.env`, builds, seeds twice, and starts through `PORT=0 npm start`. It checks HTTP 200 for the page and all frontend assets, checks GET against the supplied JSON, saves an edit, reseeds, and restarts through `npm start` to verify durability. It then stops its owned processes and removes the temporary directory. It requires npm registry access and permission to bind local ports; normal application use does not need registry access after installation.

Actual results on October 13, 2026:

| Command/check | Result |
| --- | --- |
| Supplied JSON download and SHA-256 | Downloaded successfully; hash recorded above |
| `npm install --ignore-scripts --cache /tmp/nosh-npm-cache` | Installed locked development packages; audit reported 0 vulnerabilities |
| `npm run seed` twice | First: 5 inserted; second: 0 inserted, 5 preserved |
| `node --check public/app.js` and `node --check server/app.js` | Passed |
| `npm test` | 14/14 passed, including shutdown with a speculative browser socket |
| `npm run verify:clean` | Passed from a fresh directory/cache: `npm ci`, build, two seeds, HTTP readiness, saved edit, reseed, and backend restart |
| `npm run build` | Passed; five frontend assets staged in `dist/` |
| `npm run test:ui` with Google Chrome | 12/12 passed, no uncaught browser errors |
| Core prerequisite before the bonus: `npm run build && npm run test:all` | Passed after shutdown fix: build, 14 API tests, and 12 core Chrome tests |
| `npm run test:bonus` | 6/6 passed: four Chrome flows plus two timer/cancellation/recovery unit checks |
| Final `npm run build && npm run test:all && npm run verify:clean` | Passed after bonus implementation: 5 build assets, 14 API tests, 12 core Chrome tests, 6 bonus checks, and fresh-cache install/seed/start/restart verification |
| Desktop 1440px / mobile 390px layout | Screenshots inspected; no horizontal overflow in browser assertions |
| `npm start` and live Chrome preview | Dashboard returned HTTP 200; all five original images loaded |

The first sandboxed API run was blocked by `listen EPERM` on loopback; the complete suite passed after granting permission to bind local ports. The initial offline dependency-install attempt lacked cached npm metadata; the network-enabled install succeeded. These were environment restrictions, not passing test runs.

Before implementing the bonus, the core outage check exposed shutdown waiting on a speculative browser TCP connection that had sent no HTTP request. The backend now closes all connections when stopped; a new API regression test verifies that case. The entire required suite and clean setup then passed before polling was added. Early parallel bonus runs were stopped while diagnosing slow Chrome teardown and are not counted as successful suite runs; the complete focused rerun passed 6/6. Chrome teardown can add time after the assertions finish. No temporary test diagnostics remain in the source.

The API suite verifies the supplied records/version types, actual reseeding of a partial database after name/status/image edits (four missing IDs inserted, then zero), explicit boolean updates, real process-restart persistence, empty-name rejection, invalid stored image rejection, trimmed unpublished empty names, payload/ID/JSON errors (including raw dot-segment identifiers), stale conflicts, two simultaneous writes through separate backend processes, atomic seed failure, and JSON 500 handling. The image edit is made only in an isolated temporary test database; the supplied JSON is unchanged. The browser suite verifies draft/discard without any PATCH, the exact Save payload and pending state, trimmed saved values across refresh/restart, validation correction, stale two-tab conflicts and reload confirmation, actual backend-unavailable recovery, HTML/JSON errors, loading/empty/fetch-error states, responsive broken-image rendering, independent dish errors/pending drafts, malformed success/list responses, failed conflict reload preservation, and unreadable-conflict recovery.

### Requirement-to-evidence audit

The PDF was reread for this audit; the secondary spec did not override it. The following runtime results were rerun, rather than inferred from source inspection.

| Required item | Evidence / outcome |
| --- | --- |
| Clean install, configuration, seed, start | `npm run verify:clean`: actual fresh-cache `npm ci`, example `.env`, two seed runs, `npm start`, and static routes returned 200 |
| Supplied persistent records, unique IDs, version 1 | API `GET returns all supplied dishes...`: exact supplied records/booleans/version 1; SQLite primary key; JSON hash unchanged |
| Reseed inserts missing IDs and preserves all edits | API `real seed command inserts only missing IDs...`: partial database with edited name, status, image, and version; 4 inserted/1 preserved, then 0 inserted/5 preserved |
| GET contains all five required fields | Exact record assertions in API suite and clean-setup verification |
| PATCH identifiers, types, required fields, positive integer versions | API validation tests cover missing/wrong/extra fields, malformed IDs, raw dot segments, JSON, and body limits; 400 without mutation |
| Reject empty published name and invalid stored image without mutation | API publication test checks empty/whitespace names and the isolated `file:` fixture; GET before/after records match |
| Unknown dish | API identifier test: valid unknown ID returns JSON 404 without mutation |
| Explicit name/status update, atomic version increment | API save/restart and concurrent tests: status is not toggled; two backend processes sharing SQLite produce exactly one 200 and one 409 |
| Stale request includes current dish/version, no mutation | API stale-update test compares `currentDish` and final GET to the winning response |
| Local drafts, unsaved marker, Discard | Chrome draft test: no PATCH on edits or Discard, original server fields restored |
| Save payload, pending disable, returned snapshot | Chrome save test inspects exact draft/name/boolean/version payload, disables Save, adopts trimmed response/version, clears unsaved state |
| Persistence through refresh and backend restart | Chrome save test reloads the page, stops/restarts the real backend, and verifies saved values/version; API and clean-setup checks also restart |
| 400 / 5xx / network failure retain editable drafts | Chrome validation, HTML/JSON error, and actual backend-outage tests retain drafts and successfully correct/retry |
| Two-tab conflict retains winning state and losing draft | Chrome two-tab test retains draft and version 1, displays the winner/version 2 separately, cancels and accepts reload confirmation; no automatic newer-version retry |
| Failed conflict reload / independent dishes | Chrome tests retain conflict/draft through failed reload; independently pending/saved/failed cards do not mix state |
| Loading, empty, fetch error, broken images, mobile | Chrome state/layout tests pass; 390px mobile and 1440px desktop have no horizontal overflow; generated screenshots inspected |
| Documentation, safe example environment | This README and `.env.example`; environment file contains local settings and no credentials |
| GitHub repository/access, branch and final SHA in Internshala | Repository: `PreetKot/NOSH.`; branch `main`; obtain the exact submission SHA with `git rev-parse HEAD`. Internshala submission and reviewer-specific access remain to be confirmed |
| Actual total effort and AI/reuse disclosure | **Author-reported total: 1–2 days**, including preparation/review. OpenAI Codex and third-party dependencies/assets are disclosed below |
| Optional synchronization | **Implemented separately after core passed**: three-second polling; focused verification command and behavior documented above |

### Isolated invalid-image reproduction

The fixture is an unpublished test-only dish with a `file:` image URL. Seeding it is allowed because publication rules only apply to published dishes. Use a separate database, never edit the supplied assessment JSON:

```sh
NOSH_TEST_DIR=$(mktemp -d)
DATABASE_PATH="$NOSH_TEST_DIR/dishes.sqlite" SEED_FILE=./tests/fixtures/invalid-image.json npm run seed
DATABASE_PATH="$NOSH_TEST_DIR/dishes.sqlite" PORT=3001 npm start
```

In another terminal:

```sh
curl -s http://127.0.0.1:3001/dishes
curl -i -X PATCH http://127.0.0.1:3001/dishes/test-invalid-image \
  -H 'Content-Type: application/json' \
  -d '{"dishName":"Valid name","isPublished":true,"expectedVersion":1}'
curl -s http://127.0.0.1:3001/dishes
```

Expect 400 with `A published dish must have a valid HTTP/HTTPS image URL.` The final GET still shows version 1, the original name, and `isPublished: false`. Stop that server with Ctrl+C. This exact rejection and unchanged-record assertion also passed in `npm test`.

### Manual reviewer walkthrough

These are reproducible steps; the equivalent acceptance flows were executed by the automated tests, rather than claiming a separate human click-through.

1. Seed and start. Open browser developer tools → Network, clear the log, and filter for `dishes`. Edit a name and flip its switch. Confirm “Unsaved changes”, no PATCH in the network log, and GET still shows the original fields. Click Discard and confirm the original name/status return with no PATCH.
2. Edit and Save. Confirm the version increases and the unsaved count clears. Refresh, stop the backend, restart `npm start`, and refresh again. The saved values/version remain. Run `npm run seed` again and confirm they still remain.
3. Clear a published dish's name and Save. The inline validation error appears; the empty draft is retained and GET remains unchanged. Correct the name and retry. Use the isolated fixture above for invalid images.
4. Open the dashboard in two tabs before either saves. Edit the same dish in both. Save A, then Save B. B shows a newer-update conflict while retaining its draft and original version; GET shows A's values. Cancel the reload confirmation to retain B's draft. Confirm reload to discard it and load the current values.
5. With a loaded draft, stop the backend and click Save. The connection error retains the editable draft. Restart the backend on the same port, then Save again. The unchanged expected version succeeds if nobody else saved; otherwise 409 safely reports the newer state.
6. Send a PATCH missing `expectedVersion`, with `isPublished` as a string, or using `/dishes/%20`: expect 400. Use the unknown-ID example for 404. `npm test` performs concurrent same-version writes and asserts exactly one 200 and one 409 with the unchanged winning record.

## Limitations, effort, and disclosure

- **Optional external-update synchronization: implemented.** Three-second polling is eventually consistent, subject to request delay and browser throttling; it preserves dirty drafts and original versions.
- Drafts live in the open page's memory. Refreshing/navigating away loses unsaved drafts; persisted server values survive. Only saved records are durable.
- Supplied images load directly from their original URLs; all five loaded in the live preview, but future availability is not guaranteed and the fallback handles failures. Optional Google Fonts fall back to system fonts when unavailable. Cross-browser testing beyond the installed Chrome was not performed.
- The synchronous SQLite driver suits a small local assignment; this is not production infrastructure. Authentication, uploads, creation/deletion, pagination, deployment, and approval workflows are outside scope.
- **Approximate total time spent: 1–2 days**, as reported by the author, including preparation and review. No conversion into hours is assumed.

## AI and reused assets

**AI tool used: OpenAI Codex.** Codex was used as the coding assistant to implement the frontend and backend, write tests, debug failures, verify setup, and prepare documentation. This project is AI-assisted work, and that use is disclosed explicitly.

The assignment PDF defined the requirements; the existing secondary spec was a checklist. Nosh supplied the seed JSON and dish image URLs. Google Fonts provides the optional DM Sans and Manrope fonts. Playwright is the third-party browser-test dependency; its pinned dependencies are in `package-lock.json`. The application uses Node's built-in HTTP, SQLite, and test modules. No application code was copied from another repository or starter during the documented implementation. The Sites skill guided the local frontend workflow; no hosted site was created.

## Implementation timeline

The dates below follow the recorded work sessions in Asia/Kolkata time, with the implementation stages listed in order. The author's reported overall effort is **1–2 days**.

| When | What we completed | How we did it |
| --- | --- | --- |
| October 13, 2026 | Requirements and supplied data | Read the PDF first, compared the secondary checklist, and downloaded the supplied Drive JSON without substituting data. |
| October 13, 2026 | Persistent backend and seeding | Used SQLite with unique dish IDs and version 1 inserts; made reseeding insert only missing records and preserve edits. |
| October 13, 2026 | Safe update API | Implemented GET/PATCH, server-side validation, and a transaction with a version-conditioned update to reject stale writes. |
| October 13, 2026 | Dish dashboard and local drafts | Built responsive cards with separate saved/draft state, explicit Save/Discard, per-dish errors, and confirmed conflict reloads. |
| October 13, 2026 | Core verification and fixes | Ran API and Chrome tests for persistence, concurrency, invalid input, conflicts, outage retry, and mobile states; fixed identifier routing and speculative-socket shutdown. |
| October 13, 2026 | Optional synchronization bonus | Added three-second polling after the core passed, preserving dirty drafts and handling disconnect/reconnect and timer cleanup. |
| October 13, 2026 | Submission audit | Verified clean install/seed/start, reran the build and all 32 checks, inspected tracked files for secrets/artifacts, and prepared submission information. |
| October 14, 2026 | Documentation and GitHub handoff | Added the explicit Codex disclosure, recorded this timeline, and prepared the final source and documentation for the requested `main` branch push. |

## GitHub submission

The final acceptance/status table and unsent Internshala/Google Form drafts are in [SUBMISSION-AUDIT.md](SUBMISSION-AUDIT.md). The later guide's [Google Form](https://forms.gle/zegbxdqL1awBEKzp6) is an additional channel; the PDF still explicitly requires the repository URL, branch, final SHA, bonus status, and effort in Internshala chat.

Repository: [PreetKot/NOSH.](https://github.com/PreetKot/NOSH.). Submission branch: **`main`**. Use the SHA of the exact committed version you submit, rather than an older core-only commit. These commands identify that version:

```sh
git remote get-url origin
git branch --show-current
git rev-parse HEAD
```

The application source, seed, fixtures, dependency files, README, submission audit, and safe `.env.example` belong in Git. The local database, real `.env`, generated build/screenshots, and `node_modules` are excluded. The pre-existing PDF, spec, and prompt documents remain local reference material and are not required application assets.

Send the actual repository URL, branch, final SHA, “Optional bonus: implemented with three-second polling”, and your confirmed approximate total time in the Internshala chat. If private, obtain the hiring team's reviewer account and grant access before submitting. Submit the repository, not a ZIP or video.

# Nosh dish dashboard

A locally runnable dish editor with persistent SQLite storage, explicit Save/Discard, backend publication validation, and optimistic concurrency. The PDF is the source of requirements; `NOSH-assessment-spec.md` was used as a secondary checklist.

## Prerequisites and setup

- **Node.js 22.13 or newer**, with npm. Verified on Node 22.23.3 and npm 10.9.9 on macOS.
- A modern browser. Google Chrome is needed for the default browser test command, but not for running the application.
- No separate database installation, API keys, or required build step.

Clone the repository URL supplied in the submission chat, then enter it. Replace `REPOSITORY_URL` below with that real URL; a GitHub remote has not yet been configured for this workspace.

```sh
git clone REPOSITORY_URL nosh-dish-dashboard
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

The frontend uses native browser modules. This dependency-free build checks JavaScript syntax and stages `index.html`, `app.js`, `api.js`, and `styles.css` in ignored `dist/`. No transpilation is needed. The local backend serves the source assets from `public/`, so normal development does not require a build. The staged frontend still needs the API on the same origin.

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
public/index.html + app.js + styles.css
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

Each dish editor has three separate values: the last loaded/saved snapshot, an editable local draft, and an optional conflict `currentDish`. Save sends the version from the snapshot. Success replaces both snapshot and draft with the returned values. Failure leaves the draft intact. A conflict never advances its version or automatically retries. Save is blocked until an explicit conflict reload; reload fetches the latest record and requires confirmation that the draft will be lost. Discard restores the original snapshot, even after a conflict. Fields and actions are disabled during a request to avoid editing a draft while its save is in flight.

Network/timeout, validation, and server failures appear next to the dish. The request helper safely catches non-JSON responses and validates the backend's array/dish shapes before replacing any state. A malformed success response preserves the draft and original snapshot. Even an unreadable 409 blocks stale retries and offers a confirmed reload; a failed reload preserves the draft and conflict details. Each dish's pending state and errors are independent. Explicit reload also refreshes the displayed image from the loaded snapshot. The dashboard includes loading, empty, retry, unsaved indicators, published/version metadata, responsive cards, labeled controls, and image-error fallbacks.

## Automated verification

```sh
npm run verify:clean
npm run build
npm test
npm run test:ui
# Or both in sequence:
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
| `npm test` | 13/13 passed, including the backend follow-up checks |
| `npm run verify:clean` | Passed from a fresh directory/cache: `npm ci`, build, two seeds, HTTP readiness, saved edit, reseed, and backend restart |
| `npm run build` | Passed; four frontend assets staged in `dist/` |
| `npm run test:ui` with Google Chrome | 12/12 passed, no uncaught browser errors |
| `npm run build && npm run test:all` in the final audit | Passed: build, 13 API tests, and 12 Chrome tests |
| Desktop 1440px / mobile 390px layout | Screenshots inspected; no horizontal overflow in browser assertions |
| `npm start` and live Chrome preview | Dashboard returned HTTP 200; all five original images loaded |

The first sandboxed API run was blocked by `listen EPERM` on loopback; the complete suite passed after granting permission to bind local ports. The initial offline dependency-install attempt lacked cached npm metadata; the network-enabled install succeeded. These were environment restrictions, not passing test runs.

The API suite verifies the supplied records/version types, actual reseeding of a partial database after name/status/image edits (four missing IDs inserted, then zero), explicit boolean updates, real process-restart persistence, empty-name rejection, invalid stored image rejection, trimmed unpublished empty names, payload/ID/JSON errors (including raw dot-segment identifiers), stale conflicts, two simultaneous writes through separate backend processes, atomic seed failure, and JSON 500 handling. The image edit is made only in an isolated temporary test database; the supplied JSON is unchanged. The browser suite verifies draft/discard without any PATCH, the exact Save payload and pending state, trimmed saved values across refresh/restart, validation correction, stale two-tab conflicts and reload confirmation, actual backend-unavailable recovery, HTML/JSON errors, loading/empty/fetch-error states, responsive broken-image rendering, independent dish errors/pending drafts, malformed success/list responses, failed conflict reload preservation, and unreadable-conflict recovery.

### Requirement-to-evidence audit

The PDF was reread for this audit; the secondary spec did not override it. The following runtime results were rerun, rather than inferred from source inspection.

| Required item | Evidence / outcome |
| --- | --- |
| Clean install, configuration, seed, start | `npm run verify:clean`: actual fresh-cache `npm ci`, example `.env`, two seed runs, `npm start`, and all four static routes returned 200 |
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
| GitHub repository/access, branch and final SHA in Internshala | **Pending external submission.** Local Git tracking can be verified with the commands below; no GitHub publication/access grant/chat submission is claimed |
| Actual total effort and any additional reuse | **Pending author confirmation.** The original 10-minute figure covered only the first implementation pass and is not a total |
| Optional synchronization | **Not implemented**, as requested; excluded from required checks |

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

- **Optional external-update synchronization: not implemented.** It was not requested. There is no polling, SSE, or WebSocket timer. External saves are discovered on explicit reload or stale-save conflict.
- Drafts live in the open page's memory. Refreshing/navigating away loses unsaved drafts; persisted server values survive. Only saved records are durable.
- Supplied images load directly from their original URLs; all five loaded in the live preview, but future availability is not guaranteed and the fallback handles failures. Optional Google Fonts fall back to system fonts when unavailable. Cross-browser testing beyond the installed Chrome was not performed.
- The synchronous SQLite driver suits a small local assignment; this is not production infrastructure. Authentication, uploads, creation/deletion, pagination, deployment, and approval workflows are outside scope.
- **Approximate total time spent: pending author confirmation.** The earlier 10-minute figure described only the initial AI-assisted implementation pass. Subsequent backend, frontend, and audit work occurred in later turns. The contributor's preparation/review time and honest overall total cannot be inferred; the author has been asked to provide them. Complete this field before submitting.
- **AI/reuse disclosure, verified in this conversation:** OpenAI Codex generated the application, tests, styling, setup verification, and README, and ran the recorded checks. The PDF and existing spec guided requirements. The seed JSON and image URLs come from Nosh; Google Fonts are optional external font assets; Playwright is a third-party browser-test dependency, with its dependencies recorded in `package-lock.json`. No application code was copied from another repository or starter during this conversation. The Sites skill was used for its local-only workflow; no site was registered or published. **Additional author-used AI tools or borrowed code: pending author confirmation.** The author has been asked for facts outside this conversation. Review and understand the implementation before the follow-up discussion.

## GitHub submission

This starting directory had no `.git` repository or configured remote. The audit prepares local application tracking, including `.env.example`; verify it using `git ls-files .env.example` and obtain the actual commit with `git rev-parse HEAD`. No GitHub repository, access grant, or Internshala submission is claimed. Complete the pending time/reuse fields above, create an empty GitHub repository that the hiring team can access, then run the following from this directory. Replace the example remote with your actual repository URL:

```sh
npm run test:all
git add .gitignore .env.example package.json package-lock.json README.md server public scripts data/dishes.json tests
git commit -m "Finalize assignment disclosure and submission"
git remote add origin https://github.com/YOUR_ACCOUNT/YOUR_REPOSITORY.git
git push -u origin main
git remote get-url origin
git branch --show-current
git rev-parse HEAD
```

The explicit `git add` includes every required application file, seed, fixture, dependency file, and README. The local database, `.env`, generated screenshots, and `node_modules` remain excluded. Your pre-existing PDF, spec, and prompt documents remain in this workspace and need not be part of the application submission.

Send the actual repository URL, branch, final SHA, “Optional bonus: not implemented”, and your confirmed approximate total time in the Internshala chat. If private, obtain the hiring team's reviewer account and grant access before submitting. Submit the repository, not a ZIP or video.

# Nosh dish dashboard

A responsive dish editor with persistent SQLite storage, local Save/Discard drafts, safe versioned updates, and automatic external-update notifications.

## Quick start

**Requires:** Node.js **22.13+**, npm, and a modern browser. No separate database service or API keys are needed.

If you use nvm, run `nvm install` and `nvm use` to select the Node 22 version specified in `.nvmrc`.

```sh
git clone https://github.com/PreetKot/NOSH..git nosh-dish-dashboard
cd nosh-dish-dashboard
npm ci
cp .env.example .env
npm run seed
npm start
```

Open **http://127.0.0.1:3000**. Stop with Ctrl+C. `npm run dev` enables backend watch mode.

Configuration is documented in [`.env.example`](.env.example):

```dotenv
HOST=127.0.0.1
PORT=3000
DATABASE_PATH=./data/nosh.sqlite
SEED_FILE=./data/dishes.json
```

The five supplied dishes are bundled in [`data/dishes.json`](data/dishes.json), downloaded from the [PDF's Drive link](https://drive.google.com/file/d/1iOh0c2r919zNUAz2FHqOSeZBjxjXglj1/view?usp=share_link). New dishes start at **version 1**. Rerunning `npm run seed` inserts only missing IDs and preserves existing names, image URLs, statuses, and versions. Saved data survives restarts in `data/nosh.sqlite`; keep that file between runs.

No separate migration step is needed. The schema is created automatically when the database is first opened by the seed command or server, in [`server/database.js`](server/database.js).

## API

| Endpoint | Request | Response |
| --- | --- | --- |
| `GET /dishes` | No body | Array of dishes, or `[]` |
| `PATCH /dishes/:dishId` | `dishName`, `isPublished`, `expectedVersion` | Saved dish with incremented version |

```sh
curl http://127.0.0.1:3000/dishes

# Use the current version from GET; this example assumes version 1.
curl -i -X PATCH http://127.0.0.1:3000/dishes/1 \
  -H 'Content-Type: application/json' \
  -d '{"dishName":"Jeera Rice Special","isPublished":false,"expectedVersion":1}'
```

- All three PATCH fields are required: a string name, an explicit boolean status, and a positive safe integer version. Unknown fields are rejected.
- Saved names are trimmed. Unpublished names may be empty. Publishing requires a non-empty trimmed name and a parseable stored HTTP/HTTPS image URL; reachability is not checked.
- IDs are 1–64 letters, digits, underscores, or hyphens, starting with a letter or digit. Invalid input returns **400**, unknown dishes **404**, stale versions **409**, and unexpected failures **500**.
- Every accepted save increments the version. Validation failures and conflicts leave the record unchanged. Publication saves the supplied boolean rather than toggling it.

<details>
<summary>Response examples: success, validation, missing dish, conflict</summary>

**200 — saved dish** (GET returns an array of these objects):

```json
{
  "dishId": "1",
  "dishName": "Jeera Rice Special",
  "imageUrl": "https://nosh-assignment.s3.ap-south-1.amazonaws.com/jeera-rice.jpg",
  "isPublished": false,
  "version": 2
}
```

**400 — empty published name:**

```json
{"error":{"code":"VALIDATION_ERROR","message":"A published dish must have a non-empty name."}}
```

**404 — unknown dish:**

```json
{"error":{"code":"NOT_FOUND","message":"Dish unknown was not found."}}
```

**409 — repeat the version-1 request after version 2 exists:**

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

All application errors use `{"error":{"code":"...","message":"..."}}`; conflicts additionally include `currentDish`.

</details>

## Architecture and design

```text
public/   HTML, CSS, browser modules, local drafts and polling
   ↓      Same-origin HTTP requests
server/   Node HTTP API, validation and SQLite transactions
   ↓
data/nosh.sqlite   Persistent dish records
```

**Decision:** use Node's built-in modules and SQLite to keep setup small and explainable. `BEGIN IMMEDIATE` protects the version check and `UPDATE ... WHERE dishId = ? AND version = ?`, so concurrent stale writes cannot overwrite a newer save.

Each editor separates its saved snapshot, editable draft, and newer server data. Edits stay local; Save sends the snapshot's version and is disabled while pending. Success adopts the returned values. Errors preserve the draft; conflict reload requires confirmation. Discard restores the last loaded snapshot.

## Verification

```sh
npm run verify:clean   # Fresh install, seed/reseed, HTTP startup and restart persistence
npm run build         # Validate browser JS and stage five static assets in dist/
npm run test:all       # API, core browser and bonus suites
```

**Last run: October 15, 2026 — all passed.** The API suite has **14 tests**, core browser suite **12**, and bonus suite **6**. Coverage includes validation without mutation, concurrent writes, stale two-tab conflicts, drafts/Discard, pending Save, outage retry, and loading/empty/error/image/mobile states. Tests use isolated databases; the build is optional for local use because the backend serves `public/` directly.

Browser tests use installed Google Chrome. Without Chrome:

```sh
npx playwright install chromium
PLAYWRIGHT_CHROME_CHANNEL=chromium npm run test:all
```

<details>
<summary>Manual acceptance walkthrough</summary>

1. Edit a name/status. Confirm the unsaved indicator and no PATCH request before Save. Discard restores the original fields.
2. Save a valid change. Confirm the new version, refresh, restart the backend, and rerun seed: saved values remain.
3. Clear a published name and Save. Expect an inline error, unchanged server values, and a preserved draft. Correct it and retry.
4. Open the same dish in two tabs and edit both before saving. Save A, then B. B retains its draft/version and shows A's newer values; cancel or confirm Reload.
5. Stop the backend with a draft open and Save. Restart on the same port/database and retry: the draft remains available.

</details>

<details>
<summary>Reproduce invalid stored-image rejection with an isolated fixture</summary>

In terminal A:

```sh
NOSH_TEST_DIR=$(mktemp -d)
DATABASE_PATH="$NOSH_TEST_DIR/dishes.sqlite" SEED_FILE=./tests/fixtures/invalid-image.json npm run seed
DATABASE_PATH="$NOSH_TEST_DIR/dishes.sqlite" PORT=3001 npm start
```

In terminal B:

```sh
curl -s http://127.0.0.1:3001/dishes
curl -i -X PATCH http://127.0.0.1:3001/dishes/test-invalid-image \
  -H 'Content-Type: application/json' \
  -d '{"dishName":"Valid name","isPublished":true,"expectedVersion":1}'
curl -s http://127.0.0.1:3001/dishes
```

Expect **400** for the fixture's `file:` URL. The final GET must retain the original name, unpublished status, and version 1. Stop the test server with Ctrl+C. This case also passes automatically in the API suite; the supplied assessment JSON is unchanged.

</details>

## Optional bonus — implemented

The dashboard polls GET every **3 seconds**. Clean dishes refresh automatically; dirty drafts keep both fields and their original version while showing newer saved data separately. Reload requires confirmation; no PATCH is retried automatically. Discard restores the snapshot, after which a later poll can refresh the now-clean dish.

Failed polls retain state and retry automatically; a successful read clears the connection notice. Requests do not overlap and time out after 10 seconds. `pagehide` clears the timer and aborts an active poll; `pageshow` restarts it once. Normal update delay is **0–3 seconds plus request time**, with longer delays possible during disconnection or browser throttling.

To verify, PATCH a dish externally while the page is open, first with a clean card and then with a dirty draft. Also stop/restart the backend to check recovery. `npm run test:bonus` verifies these flows and cleanup.

## Timeline and disclosure

I spent approximately **8–10 hours in total** on this assignment, including the required task and the polling bonus. Dates below use Asia/Kolkata time.

| Date | Stage | Approach |
| --- | --- | --- |
| Oct 13, 2026 | Requirements and data | Read the PDF and retrieved the supplied seed JSON. |
| Oct 13, 2026 | Backend | Added persistent SQLite, idempotent seeding, validation and atomic versioned updates. |
| Oct 13, 2026 | Frontend | Built responsive editors with separate drafts, Save/Discard and conflict recovery. |
| Oct 13, 2026 | Verification and bonus | Tested core acceptance flows, fixed failures, then added polling and cleanup tests. |
| Oct 14, 2026 | Handoff | Reran all 32 checks and clean setup, documented Codex use, and pushed to GitHub. |
| Oct 15, 2026 | Review cleanup | Removed submission work logs, clarified setup and disclosure, and formatted the frontend source. |

I used **OpenAI Codex** to help implement the frontend and backend, write and run tests, debug issues, and prepare documentation. I reviewed the README and directed revisions to its structure, timeline, AI disclosure, and submission presentation. I used Nosh's supplied JSON/images, optional Google Fonts, and Playwright for browser tests. No application code was copied from another repository or starter during the documented work.

## Limitations and submission

- Unsaved drafts live only in the open page; refreshing loses them. Saved values are persistent.
- External images/fonts may fail; fallbacks are provided. Browser verification covered Chrome.
- Authentication, uploads, dish creation/deletion, pagination and production deployment are outside scope. No required application work remains incomplete.

Branch: **`main`**.

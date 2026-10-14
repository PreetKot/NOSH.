import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { runningFixture, startServer, patch, list } from './helpers.js';

let browser;
before(async () => {
  browser = await chromium.launch(process.env.PLAYWRIGHT_CHROME_CHANNEL === 'chromium'
    ? {} : { channel: process.env.PLAYWRIGHT_CHROME_CHANNEL || 'chrome' });
});
after(async () => browser?.close());

async function dashboard(t, app) {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  page.setDefaultTimeout(15000);
  await page.route('https://**/*', (route) => route.abort());
  await page.goto(app.url);
  await page.locator('.dish-card').last().waitFor();
  return page;
}
const cardFor = (page, id = '1') => page.locator(`.dish-card[data-dish-id="${id}"]`);
async function version(card, value) {
  await card.locator('.version').filter({ hasText: `Version ${value}` }).waitFor();
}

test('an external API save automatically refreshes a clean dish without page refresh or PATCH', async (t) => {
  const app = await runningFixture(t);
  const page = await dashboard(t, app);
  const writes = [];
  page.on('request', (request) => { if (request.method() === 'PATCH') writes.push(request); });
  const result = await patch(app.url, '1', { dishName: 'External clean update', isPublished: false, expectedVersion: 1 });
  assert.equal(result.status, 200);
  const card = cardFor(page);
  await version(card, 2);
  assert.equal(await card.locator('.name-input').inputValue(), 'External clean update');
  assert.equal(await card.locator('.publish-input').isChecked(), false);
  assert.match(await card.locator('.saved-status').innerText(), /Unpublished/);
  assert.equal(await page.locator('#published-count').innerText(), '4');
  assert.equal(await page.locator('#draft-count').innerText(), '0');
  assert.equal(writes.length, 0);
});

test('external updates preserve both dirty fields and the original version until an explicit decision', async (t) => {
  const app = await runningFixture(t);
  const page = await dashboard(t, app);
  const card = cardFor(page);
  const writes = [];
  page.on('request', (request) => { if (request.method() === 'PATCH') writes.push(request.postDataJSON()); });
  await card.locator('.name-input').fill('My unsaved name');
  await card.locator('.publish-input').uncheck();
  await patch(app.url, '1', { dishName: 'Newer external value', isPublished: true, expectedVersion: 1 });
  // A second clean dish refreshes even while the first has an unsaved draft.
  await patch(app.url, '2', { dishName: 'Another clean update', isPublished: false, expectedVersion: 1 });
  await card.locator('.conflict-detail').filter({ hasText: 'Newer external value' }).waitFor();
  await version(cardFor(page, '2'), 2);
  assert.equal(await card.locator('.name-input').inputValue(), 'My unsaved name');
  assert.equal(await card.locator('.publish-input').isChecked(), false);
  assert.equal(await card.locator('.version').innerText(), 'Version 1');
  assert.equal(writes.length, 0, 'Polling must never save or retry drafts');
  page.once('dialog', (dialog) => { assert.match(dialog.message(), /discard your local draft/); dialog.dismiss(); });
  await card.locator('.reload-button').click();
  assert.equal(await card.locator('.name-input').inputValue(), 'My unsaved name');
  // An explicit stale Save still uses version 1 and gets the normal core 409.
  await card.locator('.save-button').click();
  await card.locator('.dish-error').filter({ hasText: 'newer update' }).waitFor();
  assert.deepEqual(writes, [{ dishName: 'My unsaved name', isPublished: false, expectedVersion: 1 }]);
  assert.equal(await card.locator('.name-input').inputValue(), 'My unsaved name');
  assert.equal((await list(app.url))[0].dishName, 'Newer external value');
  page.once('dialog', (dialog) => dialog.accept());
  await card.locator('.reload-button').click();
  await version(card, 2);
  assert.equal(await card.locator('.name-input').inputValue(), 'Newer external value');
  assert.equal(await card.locator('.publish-input').isChecked(), true);
  assert.equal(await card.locator('.conflict').isHidden(), true);
});

test('polling survives an actual backend outage, preserves a draft, and resumes after restart', async (t) => {
  const app = await runningFixture(t);
  const page = await dashboard(t, app);
  const card = cardFor(page);
  await card.locator('.name-input').fill('Draft during outage');
  await card.locator('.publish-input').uncheck();
  await app.stop();
  await page.locator('#sync-state').filter({ hasText: 'unavailable' }).waitFor();
  assert.equal(await card.locator('.name-input').inputValue(), 'Draft during outage');
  assert.equal(await card.locator('.publish-input').isChecked(), false);
  const restarted = await startServer(app.filename, app.port);
  t.after(() => restarted.stop());
  await patch(restarted.url, '2', { dishName: 'After reconnect', isPublished: false, expectedVersion: 1 });
  await version(cardFor(page, '2'), 2);
  await page.locator('#sync-state').filter({ hasText: 'Live updates on' }).waitFor();
  assert.equal(await card.locator('.name-input').inputValue(), 'Draft during outage');
  assert.equal(await card.locator('.version').innerText(), 'Version 1');
  await card.locator('.save-button').click();
  await version(card, 2);
});

test('pagehide stops polling; pageshow restarts only one timer', async (t) => {
  const app = await runningFixture(t);
  const page = await dashboard(t, app);
  const reads = [];
  page.on('request', (request) => {
    if (request.method() === 'GET' && new URL(request.url()).pathname === '/dishes') reads.push(request);
  });
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  // Wait beyond one real polling interval to prove no GET is emitted after teardown.
  await page.waitForTimeout(3300);
  assert.equal(reads.length, 0);
  await patch(app.url, '1', { dishName: 'While page suspended', isPublished: false, expectedVersion: 1 });
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await version(cardFor(page), 2);
  assert.equal(reads.length, 1, 'Duplicate pageshow events must not create duplicate polling timers');
});

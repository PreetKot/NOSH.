import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { runningFixture, startServer, list, patch } from './helpers.js';

let browser;
before(async () => {
  browser = await chromium.launch(process.env.PLAYWRIGHT_CHROME_CHANNEL === 'chromium' ? {} : { channel: process.env.PLAYWRIGHT_CHROME_CHANNEL || 'chrome' });
});
after(async () => browser?.close());

async function pageFor(t, app, viewport = { width: 1440, height: 1100 }) {
  const context = await browser.newContext({ viewport });
  t.after(() => context.close());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], 'No uncaught browser errors'));
  // Avoid relying on image/font hosts during functional tests.
  await page.route('https://**/*', (route) => route.abort());
  await page.goto(app.url);
  return page;
}
const cardFor = (page, id = '1') => page.locator(`.dish-card[data-dish-id="${id}"]`);
async function saved(card, version) { await card.locator('.version').filter({ hasText: `Version ${version}` }).waitFor(); }

test('draft name/status stay local; Discard restores the original snapshot', async (t) => {
  const app = await runningFixture(t);
  const page = await pageFor(t, app);
  const card = cardFor(page);
  const writes = [];
  page.on('request', (request) => { if (request.method() === 'PATCH') writes.push(request); });
  await card.locator('.name-input').fill('Unsaved rice');
  await card.locator('.publish-input').uncheck();
  assert.match(await card.locator('.edit-state').innerText(), /Unsaved changes/);
  assert.equal(await page.locator('#draft-count').innerText(), '1');
  assert.equal((await list(app.url))[0].dishName, 'Jeera Rice');
  assert.equal((await list(app.url))[0].isPublished, true);
  await card.locator('.discard-button').click();
  assert.equal(await card.locator('.name-input').inputValue(), 'Jeera Rice');
  assert.equal(await card.locator('.publish-input').isChecked(), true);
  assert.equal(await card.locator('.save-button').isDisabled(), true);
  assert.equal(await page.locator('#draft-count').innerText(), '0');
  assert.equal(writes.length, 0, 'Editing and Discard never send PATCH');
});

test('Save disables during the request, adopts trimmed response and survives refresh and restart', async (t) => {
  const app = await runningFixture(t);
  const page = await pageFor(t, app);
  const card = cardFor(page);
  const writes = [];
  page.on('request', (request) => { if (request.method() === 'PATCH') writes.push(request.postDataJSON()); });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await page.route('**/dishes/1', async (route) => { await gate; await route.continue(); });
  await card.locator('.name-input').fill('  Browser saved rice  ');
  await card.locator('.publish-input').uncheck();
  await card.locator('.save-button').click();
  assert.equal(await card.locator('.save-button').isDisabled(), true);
  assert.equal(await card.locator('.name-input').isDisabled(), true);
  release();
  await saved(card, 2);
  assert.deepEqual(writes, [{ dishName: '  Browser saved rice  ', isPublished: false, expectedVersion: 1 }]);
  assert.equal(await card.locator('.name-input').inputValue(), 'Browser saved rice');
  assert.match(await card.locator('.edit-state').innerText(), /Saved successfully/);
  await page.reload();
  await saved(cardFor(page), 2);
  await app.stop();
  const restarted = await startServer(app.filename, app.port);
  t.after(() => restarted.stop());
  await page.reload();
  await saved(cardFor(page), 2);
  assert.equal(await cardFor(page).locator('.name-input').inputValue(), 'Browser saved rice');
  assert.equal(await cardFor(page).locator('.publish-input').isChecked(), false);
});

test('backend validation preserves an empty draft and allows correction', async (t) => {
  const app = await runningFixture(t);
  const page = await pageFor(t, app);
  const card = cardFor(page);
  await card.locator('.name-input').fill('   ');
  await card.locator('.save-button').click();
  await card.locator('.dish-error').waitFor();
  assert.match(await card.locator('.dish-error').innerText(), /non-empty/);
  assert.equal(await card.locator('.name-input').inputValue(), '   ');
  assert.equal((await list(app.url))[0].version, 1);
  await card.locator('.name-input').fill('Corrected name');
  await card.locator('.save-button').click();
  await saved(card, 2);
});

test('two stale tabs preserve the winning save and losing draft; reload requires confirmation', async (t) => {
  const app = await runningFixture(t);
  const a = await pageFor(t, app);
  const b = await pageFor(t, app);
  const ca = cardFor(a), cb = cardFor(b);
  await ca.locator('.name-input').fill('Tab A winner');
  await cb.locator('.name-input').fill('Tab B draft');
  await cb.locator('.publish-input').uncheck();
  await ca.locator('.save-button').click();
  await saved(ca, 2);
  await cb.locator('.save-button').click();
  await cb.locator('.conflict').waitFor();
  assert.equal(await cb.locator('.name-input').inputValue(), 'Tab B draft');
  assert.equal(await cb.locator('.publish-input').isChecked(), false);
  assert.equal(await cb.locator('.version').innerText(), 'Version 1');
  assert.match(await cb.locator('.conflict-detail').innerText(), /Tab A winner.*Version 2/);
  assert.equal((await list(app.url))[0].dishName, 'Tab A winner');
  b.once('dialog', (dialog) => { assert.match(dialog.message(), /discard your local draft/); dialog.dismiss(); });
  await cb.locator('.reload-button').click();
  assert.equal(await cb.locator('.name-input').inputValue(), 'Tab B draft');
  // Discard uses the original saved snapshot, never the conflict's separate currentDish.
  await cb.locator('.discard-button').click();
  assert.equal(await cb.locator('.name-input').inputValue(), 'Jeera Rice');
  assert.equal(await cb.locator('.version').innerText(), 'Version 1');
  await cb.locator('.name-input').fill('Another local draft');
  b.once('dialog', (dialog) => dialog.accept());
  await cb.locator('.reload-button').click();
  await saved(cb, 2);
  assert.equal(await cb.locator('.name-input').inputValue(), 'Tab A winner');
  assert.equal(await cb.locator('.conflict').isHidden(), true);
});

test('real backend outage preserves an editable draft; restarting allows retry', async (t) => {
  const app = await runningFixture(t);
  const page = await pageFor(t, app);
  const card = cardFor(page);
  await card.locator('.name-input').fill('Offline draft');
  await app.stop();
  await card.locator('.save-button').click();
  await card.locator('.dish-error').waitFor();
  assert.match(await card.locator('.dish-error').innerText(), /Could not reach/);
  assert.equal(await card.locator('.name-input').inputValue(), 'Offline draft');
  await card.locator('.name-input').fill('Offline draft revised');
  const restarted = await startServer(app.filename, app.port);
  t.after(() => restarted.stop());
  await card.locator('.save-button').click();
  await saved(card, 2);
  assert.equal((await list(restarted.url))[0].dishName, 'Offline draft revised');
});

test('HTML error responses and JSON server errors preserve drafts and allow retry', async (t) => {
  const app = await runningFixture(t);
  const page = await pageFor(t, app);
  const card = cardFor(page);
  await card.locator('.name-input').fill('Preserved draft');
  await page.route('**/dishes/1', (route) => route.fulfill({ status: 502, contentType: 'text/html', body: '<h1>Bad gateway</h1>' }));
  await card.locator('.save-button').click();
  await card.locator('.dish-error').waitFor();
  assert.match(await card.locator('.dish-error').innerText(), /unreadable error.*502/);
  assert.equal(await card.locator('.name-input').inputValue(), 'Preserved draft');
  await page.unroute('**/dishes/1');
  await page.route('**/dishes/1', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Temporary server failure' } }) }));
  await card.locator('.save-button').click();
  await card.locator('.dish-error').filter({ hasText: 'Temporary server failure' }).waitFor();
  assert.equal(await card.locator('.name-input').inputValue(), 'Preserved draft');
  await page.unroute('**/dishes/1');
  await card.locator('.save-button').click();
  await saved(card, 2);
});

test('loading, initial fetch failure, retry and empty states are readable', async (t) => {
  const app = await runningFixture(t, { rows: [] });
  const page = await pageFor(t, app);
  await page.locator('#load-state').filter({ hasText: 'No dishes yet' }).waitFor();
  await page.route('**/dishes', (route) => route.fulfill({ status: 503, contentType: 'text/html', body: 'Unavailable' }));
  await page.reload();
  await page.getByRole('button', { name: 'Try again' }).waitFor();
  assert.match(await page.locator('#load-state').innerText(), /Could not load dishes/);
  await page.unroute('**/dishes');
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await page.route('**/dishes', async (route) => { await gate; await route.continue(); });
  await page.getByRole('button', { name: 'Try again' }).click();
  assert.equal(await page.locator('#load-state').innerText(), 'Loading your dishes…');
  release();
  await page.locator('#load-state').filter({ hasText: 'No dishes yet' }).waitFor();
  assert.equal(await page.locator('#total-count').innerText(), '0');
});

test('all dish metadata and broken-image fallbacks render without mobile overflow', async (t) => {
  const app = await runningFixture(t);
  const page = await pageFor(t, app, { width: 390, height: 844 });
  await cardFor(page).locator('.image-fallback').waitFor();
  assert.equal(await page.locator('.dish-card').count(), 5);
  assert.match(await cardFor(page).innerText(), /DISH #1.*Version 1/s);
  assert.match(await cardFor(page).locator('.saved-status').innerText(), /Published/);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.evaluate(() => new Promise((resolve) => { window.scrollTo(0, 0); requestAnimationFrame(() => requestAnimationFrame(resolve)); }));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: 'test-results/desktop.png', fullPage: true });
});

test('independent dishes retain their own drafts, pending states and errors', async (t) => {
  const app = await runningFixture(t);
  const page = await pageFor(t, app);
  const first = cardFor(page, '1'), second = cardFor(page, '2');
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await page.route('**/dishes/1', async (route) => { await gate; await route.continue(); });
  await page.route('**/dishes/2', (route) => route.fulfill({
    status: 500, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Second dish failed. Try again.' } })
  }));
  await first.locator('.name-input').fill('First independent draft');
  await second.locator('.name-input').fill('Second independent draft');
  await second.locator('.publish-input').uncheck();
  await first.locator('.save-button').click();
  assert.equal(await second.locator('.name-input').isEnabled(), true);
  await second.locator('.save-button').click();
  await second.locator('.dish-error').waitFor();
  assert.equal(await first.locator('.dish-error').isHidden(), true);
  assert.equal(await first.locator('.save-button').isDisabled(), true);
  release();
  await saved(first, 2);
  assert.equal(await second.locator('.name-input').inputValue(), 'Second independent draft');
  assert.equal(await second.locator('.publish-input').isChecked(), false);
  assert.match(await second.locator('.dish-error').innerText(), /Second dish failed/);
  assert.equal(await second.locator('.version').innerText(), 'Version 1');
  assert.equal(await page.locator('#draft-count').innerText(), '1');
  await page.unroute('**/dishes/2');
  await second.locator('.save-button').click();
  await saved(second, 2);
  assert.equal(await first.locator('.name-input').inputValue(), 'First independent draft');
  assert.equal(await page.locator('#draft-count').innerText(), '0');
});

test('malformed successful responses cannot replace snapshots or partially render a list', async (t) => {
  const app = await runningFixture(t);
  const page = await pageFor(t, app);
  const card = cardFor(page);
  await card.locator('.name-input').fill('Still my draft');
  await page.route('**/dishes/1', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: 'null' }));
  await card.locator('.save-button').click();
  await card.locator('.dish-error').waitFor();
  assert.match(await card.locator('.dish-error').innerText(), /invalid saved dish/);
  assert.equal(await card.locator('.name-input').inputValue(), 'Still my draft');
  assert.equal(await card.locator('.version').innerText(), 'Version 1');
  assert.equal(await card.locator('.save-button').isEnabled(), true);
  await page.unroute('**/dishes/1');
  await card.locator('.save-button').click();
  await saved(card, 2);
  const dishes = await list(app.url);
  await page.route('**/dishes', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([dishes[0], null]) }));
  await page.reload();
  await page.getByRole('button', { name: 'Try again' }).waitFor();
  assert.equal(await page.locator('.dish-card').count(), 0);
  await page.unroute('**/dishes');
  await page.getByRole('button', { name: 'Try again' }).click();
  await cardFor(page, '5').waitFor();
  assert.equal(await page.locator('.dish-card').count(), 5);
});

test('a failed conflict reload preserves the draft and snapshot; retry fetches the latest version', async (t) => {
  const app = await runningFixture(t);
  const page = await pageFor(t, app);
  const card = cardFor(page);
  await card.locator('.name-input').fill('Losing local draft');
  await patch(app.url, '1', { dishName: 'External version two', isPublished: false, expectedVersion: 1 });
  // Background synchronization must leave the dirty draft's fields/version alone.
  assert.equal(await card.locator('.name-input').inputValue(), 'Losing local draft');
  assert.equal(await card.locator('.version').innerText(), 'Version 1');
  await card.locator('.save-button').click();
  await card.locator('.conflict').waitFor();
  await page.route('**/dishes', (route) => route.fulfill({ status: 502, contentType: 'text/html', body: 'Unavailable' }));
  page.once('dialog', (dialog) => dialog.accept());
  await card.locator('.reload-button').click();
  await card.locator('.dish-error').filter({ hasText: '502' }).waitFor();
  assert.equal(await card.locator('.name-input').inputValue(), 'Losing local draft');
  assert.equal(await card.locator('.version').innerText(), 'Version 1');
  assert.match(await card.locator('.conflict-detail').innerText(), /External version two.*Version 2/);
  assert.equal(await card.locator('.save-button').isDisabled(), true);
  await patch(app.url, '1', { dishName: 'External version three', isPublished: true, expectedVersion: 2 });
  await page.unroute('**/dishes');
  page.once('dialog', (dialog) => dialog.accept());
  await card.locator('.reload-button').click();
  await saved(card, 3);
  assert.equal(await card.locator('.name-input').inputValue(), 'External version three');
  assert.equal(await card.locator('.conflict').isHidden(), true);
});

test('an unreadable conflict still blocks stale retry and offers an explicit reload', async (t) => {
  const app = await runningFixture(t);
  const page = await pageFor(t, app);
  const card = cardFor(page);
  await card.locator('.name-input').fill('Keep this draft');
  await patch(app.url, '1', { dishName: 'Newer saved value', isPublished: true, expectedVersion: 1 });
  await page.route('**/dishes/1', (route) => route.fulfill({ status: 409, contentType: 'text/html', body: 'Conflict' }));
  await card.locator('.save-button').click();
  await card.locator('.conflict').waitFor();
  assert.equal(await card.locator('.name-input').inputValue(), 'Keep this draft');
  assert.equal(await card.locator('.version').innerText(), 'Version 1');
  assert.equal(await card.locator('.save-button').isDisabled(), true);
  assert.match(await card.locator('.conflict-detail').innerText(), /Another update occurred/);
  page.once('dialog', (dialog) => dialog.accept());
  await card.locator('.reload-button').click();
  await saved(card, 2);
  assert.equal(await card.locator('.name-input').inputValue(), 'Newer saved value');
});

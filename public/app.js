import { getDishes, saveDish } from './api.js';
import { startPolling } from './sync.js';

const grid = document.querySelector('#dish-grid');
const loadState = document.querySelector('#load-state');
const editors = [];
let loaded = false;
let active = true;
let stopSync = null;
const draftFrom = (dish) => ({ dishName: dish.dishName, isPublished: dish.isPublished });

function startSync() {
  if (!loaded || !active || stopSync) return;
  const status = document.querySelector('#sync-state');
  if (!status.classList.contains('disconnected')) status.textContent = 'Live updates on · checked every 3 seconds';
  stopSync = startPolling({
    read: getDishes,
    onDishes(dishes) {
      for (const dish of dishes) {
        const editor = editors.find((item) => item.saved.dishId === dish.dishId);
        editor?.receive(dish);
      }
    },
    onConnection(connected) {
      status.textContent = connected ? 'Live updates on · checked every 3 seconds'
        : 'Live updates unavailable. Retrying automatically; your drafts are safe.';
      status.classList.toggle('disconnected', !connected);
    }
  });
}

window.addEventListener('pagehide', () => {
  active = false;
  stopSync?.();
  stopSync = null;
});
window.addEventListener('pageshow', () => { active = true; startSync(); });

function updateSummary() {
  document.querySelector('#total-count').textContent = editors.length;
  document.querySelector('#published-count').textContent = editors.filter((editor) => editor.saved.isPublished).length;
  document.querySelector('#draft-count').textContent = editors.filter((editor) => editor.dirty()).length;
}

function createEditor(dish) {
  const card = document.querySelector('#dish-template').content.firstElementChild.cloneNode(true);
  const find = (selector) => card.querySelector(selector);
  const name = find('.name-input');
  const published = find('.publish-input');
  const save = find('.save-button');
  const discard = find('.discard-button');
  const reload = find('.reload-button');
  const state = {
    saved: dish,
    draft: draftFrom(dish),
    currentDish: null,
    hasConflict: false,
    pending: false,
    error: '',
    notice: '',
    dirty() { return this.draft.dishName !== this.saved.dishName || this.draft.isPublished !== this.saved.isPublished; }
  };
  card.dataset.dishId = dish.dishId;
  const image = find('img');
  image.alt = dish.dishName || `Dish ${dish.dishId}`;
  image.addEventListener('error', () => { image.hidden = true; find('.image-fallback').hidden = false; });
  image.addEventListener('load', () => { image.hidden = false; find('.image-fallback').hidden = true; });
  image.src = dish.imageUrl;
  name.value = state.draft.dishName;
  published.checked = state.draft.isPublished;

  function render() {
    find('.dish-id').textContent = `DISH #${state.saved.dishId}`;
    find('.version').textContent = `Version ${state.saved.version}`;
    find('.saved-name').textContent = state.saved.dishName || 'Untitled dish';
    image.alt = state.saved.dishName || `Dish ${state.saved.dishId}`;
    if (image.getAttribute('src') !== state.saved.imageUrl) {
      image.hidden = false;
      find('.image-fallback').hidden = true;
      image.src = state.saved.imageUrl;
    }
    const status = find('.saved-status');
    status.textContent = state.saved.isPublished ? '● Published' : '○ Unpublished';
    status.classList.toggle('unpublished', !state.saved.isPublished);
    card.classList.toggle('is-dirty', state.dirty());
    find('.edit-state').textContent = state.pending ? 'Contacting the server…' : state.dirty() ? '● Unsaved changes' : state.notice || 'All changes saved';
    find('.dish-error').textContent = state.error;
    find('.dish-error').hidden = !state.error;
    find('.conflict').hidden = !state.hasConflict && !state.currentDish;
    if (state.currentDish) {
      find('.conflict-detail').textContent = `Newer saved value: “${state.currentDish.dishName || 'Untitled dish'}” · ${state.currentDish.isPublished ? 'Published' : 'Unpublished'} · Version ${state.currentDish.version}. Your draft is still based on version ${state.saved.version}.`;
    } else if (state.hasConflict) {
      find('.conflict-detail').textContent = `Another update occurred, but its values could not be read. Your draft is still based on version ${state.saved.version}. Reload to fetch the current dish.`;
    }
    save.disabled = state.pending || !state.dirty() || state.hasConflict;
    save.textContent = state.pending ? 'Please wait…' : 'Save changes ↗';
    discard.disabled = state.pending || !state.dirty();
    reload.disabled = state.pending;
    name.disabled = published.disabled = state.pending;
    updateSummary();
  }

  function replaceSaved(saved, notice) {
    state.saved = saved;
    state.draft = draftFrom(saved);
    state.currentDish = null;
    state.hasConflict = false;
    state.error = '';
    state.notice = notice;
    name.value = saved.dishName;
    published.checked = saved.isPublished;
  }

  state.receive = (incoming) => {
    // Recheck live draft/pending state at response time, not at poll start.
    if (state.pending || incoming.version <= state.saved.version) return;
    if (state.dirty()) {
      if (!state.currentDish || incoming.version > state.currentDish.version) state.currentDish = incoming;
    } else {
      replaceSaved(incoming, 'Updated from server');
    }
    render();
  };

  name.addEventListener('input', () => { state.draft.dishName = name.value; state.notice = ''; render(); });
  published.addEventListener('change', () => { state.draft.isPublished = published.checked; state.notice = ''; render(); });
  discard.addEventListener('click', () => {
    state.draft = draftFrom(state.saved);
    name.value = state.draft.dishName;
    published.checked = state.draft.isPublished;
    state.error = state.hasConflict ? 'A newer update still exists. Reload to use its version.' : '';
    state.notice = 'Draft discarded';
    render();
  });
  find('form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (save.disabled) return;
    state.pending = true;
    state.error = '';
    render();
    try {
      const saved = await saveDish(state.saved.dishId, state.draft, state.saved.version);
      replaceSaved(saved, 'Saved successfully');
    } catch (error) {
      state.error = error.message;
      // A conflict never advances the snapshot/version associated with this draft.
      if (error.status === 409) {
        state.hasConflict = true;
        if (error.currentDish?.dishId === state.saved.dishId
            && (!state.currentDish || error.currentDish.version >= state.currentDish.version)) {
          state.currentDish = error.currentDish;
        }
      }
    } finally { state.pending = false; render(); }
  });
  reload.addEventListener('click', async () => {
    if (!window.confirm('Reload the latest saved dish? This will discard your local draft.')) return;
    state.pending = true;
    render();
    try {
      const latest = (await getDishes()).find((item) => item.dishId === state.saved.dishId);
      if (!latest) throw new Error('This dish is no longer available. Your draft has been preserved.');
      replaceSaved(latest, 'Latest saved values loaded');
    } catch (error) { state.error = error.message; }
    finally { state.pending = false; render(); }
  });
  editors.push(state);
  grid.append(card);
  render();
}

async function load() {
  loadState.hidden = false;
  loadState.textContent = 'Loading your dishes…';
  try {
    const dishes = await getDishes();
    dishes.forEach(createEditor);
    updateSummary();
    if (!dishes.length) loadState.textContent = 'No dishes yet. Run npm run seed, then refresh this page.';
    else loadState.hidden = true;
    loaded = true;
    startSync();
  } catch (error) {
    loadState.textContent = `Could not load dishes. ${error.message} `;
    const retry = document.createElement('button');
    retry.textContent = 'Try again';
    retry.addEventListener('click', load);
    loadState.append(retry);
  }
}

load();

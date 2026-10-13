import { getDishes, saveDish } from './api.js';

const grid = document.querySelector('#dish-grid');
const loadState = document.querySelector('#load-state');
const editors = [];
const draftFrom = (dish) => ({ dishName: dish.dishName, isPublished: dish.isPublished });

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
    find('.conflict').hidden = !state.hasConflict;
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
      state.saved = saved;
      state.draft = draftFrom(saved);
      state.currentDish = null;
      state.hasConflict = false;
      state.notice = 'Saved successfully';
      name.value = saved.dishName;
      published.checked = saved.isPublished;
    } catch (error) {
      state.error = error.message;
      // A conflict never advances the snapshot/version associated with this draft.
      if (error.status === 409) {
        state.hasConflict = true;
        state.currentDish = error.currentDish?.dishId === state.saved.dishId ? error.currentDish : null;
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
      state.saved = latest;
      state.draft = draftFrom(latest);
      state.currentDish = null;
      state.hasConflict = false;
      state.error = '';
      state.notice = 'Latest saved values loaded';
      name.value = latest.dishName;
      published.checked = latest.isPublished;
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
  } catch (error) {
    loadState.textContent = `Could not load dishes. ${error.message} `;
    const retry = document.createElement('button');
    retry.textContent = 'Try again';
    retry.addEventListener('click', load);
    loadState.append(retry);
  }
}

load();

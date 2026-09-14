// Design page: renders the single design doc directly, with hash routing
// kept so future docs can join a list without changing this file.
const app = document.getElementById('app');

let docs = [];

function escapeHtml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function slugFromHash() {
  const hash = window.location.hash.replace(/^#\/?/, '');
  try {
    return decodeURIComponent(hash).split('/')[0] ?? '';
  } catch {
    return '';
  }
}

function renderList() {
  document.title = 'cd design';
  const items = docs
    .map(
      (doc) => `<li><a href="#/${encodeURIComponent(doc.slug)}">
        <span class="t">${escapeHtml(doc.title)}</span>
        <span class="go" aria-hidden="true">open -></span>
        ${doc.description ? `<span class="d">${escapeHtml(doc.description)}</span>` : ''}
      </a></li>`,
    )
    .join('');
  app.innerHTML = `<p class="count">${docs.length} design${docs.length === 1 ? '' : 's'}</p>
    <ul class="design-list">${items}</ul>`;
}

function renderDoc(slug) {
  const doc = docs.find((entry) => entry.slug === slug);
  if (!doc) {
    renderList();
    return;
  }
  document.title = `${doc.title} | cd design`;
  const back = docs.length > 1 ? `<a class="back" href="#/">&lt;- all designs</a>\n    ` : '';
  app.innerHTML = `${back}<article class="doc">${doc.html}</article>`;
  window.scrollTo(0, 0);
}

function render() {
  const slug = slugFromHash();
  // One doc: show it straight away, no list detour.
  if (docs.length === 1 && !slug) {
    renderDoc(docs[0].slug);
    return;
  }
  if (slug) renderDoc(slug);
  else renderList();
}

async function main() {
  try {
    const response = await fetch('./docs.json', { cache: 'no-cache' });
    if (!response.ok) throw new Error(`docs.json: ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data) || !data.every((doc) =>
      doc && typeof doc.slug === 'string' && typeof doc.title === 'string' &&
      typeof doc.description === 'string' && typeof doc.html === 'string'
    )) throw new Error('bad manifest');
    docs = data;
  } catch {
    app.innerHTML = '<p class="error">Could not load the design list. Try reloading.</p>';
    return;
  }
  window.addEventListener('hashchange', render);
  render();
}

main();

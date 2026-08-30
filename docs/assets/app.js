const pages = [...document.querySelectorAll('.doc-page')];
const navLinks = [...document.querySelectorAll('[data-page-link]')];
const sidebar = document.querySelector('.sidebar');
const pageIds = new Set(pages.map((page) => page.id));

function pageFromHash() {
  const id = location.hash.slice(1);
  return pageIds.has(id) ? id : 'overview';
}

function showPage(id, moveFocus = false) {
  const activeId = pageIds.has(id) ? id : 'overview';
  for (const page of pages) page.hidden = page.id !== activeId;
  for (const link of navLinks) {
    const active = link.getAttribute('href') === `#${activeId}`;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  sidebar?.classList.remove('open');
  document.body.dataset.page = activeId;
  const activePage = document.getElementById(activeId);
  document.title = activePage?.dataset.title
    ? `${activePage.dataset.title} · tghclparser`
    : 'tghclparser documentation';
  if (moveFocus) {
    window.scrollTo({ top: 0, behavior: 'instant' });
    activePage?.querySelector('h1')?.focus({ preventScroll: true });
  }
}

window.addEventListener('hashchange', () => showPage(pageFromHash(), true));
showPage(pageFromHash());

document.querySelector('.menu-button')?.addEventListener('click', () => {
  const isOpen = sidebar?.classList.toggle('open') ?? false;
  document.querySelector('.menu-button')?.setAttribute('aria-expanded', String(isOpen));
});

document.addEventListener('click', (event) => {
  if (window.innerWidth > 980 || !sidebar?.classList.contains('open')) return;
  const target = event.target;
  if (!(target instanceof Node)) return;
  if (!sidebar.contains(target) && !document.querySelector('.menu-button')?.contains(target)) sidebar.classList.remove('open');
});

const themeButton = document.querySelector('.theme-button');
const preferredTheme = localStorage.getItem('tghclp-theme');
if (preferredTheme) document.documentElement.dataset.theme = preferredTheme;

function updateThemeLabel() {
  const dark = document.documentElement.dataset.theme === 'dark';
  if (themeButton) {
    themeButton.textContent = dark ? '☀' : '◐';
    themeButton.setAttribute('aria-label', dark ? 'Use light theme' : 'Use dark theme');
  }
}
updateThemeLabel();

themeButton?.addEventListener('click', () => {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('tghclp-theme', theme);
  updateThemeLabel();
});

for (const block of document.querySelectorAll('.code-block')) {
  const button = document.createElement('button');
  button.className = 'copy-button';
  button.type = 'button';
  button.textContent = 'Copy';
  button.setAttribute('aria-label', 'Copy code');
  button.addEventListener('click', async () => {
    const code = block.querySelector('code')?.textContent ?? '';
    await navigator.clipboard.writeText(code);
    button.textContent = 'Copied';
    setTimeout(() => { button.textContent = 'Copy'; }, 1400);
  });
  block.append(button);
}

const dialog = document.querySelector('.search-dialog');
const searchInput = document.querySelector('#search-input');
const results = document.querySelector('.search-results');
const searchItems = pages.map((page) => ({
  id: page.id,
  title: page.dataset.title ?? '',
  kind: page.dataset.kind ?? '',
  text: page.textContent?.replace(/\s+/g, ' ').trim() ?? ''
}));

function renderSearch(query = '') {
  if (!results) return;
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const matches = searchItems.filter((item) => terms.every((term) => `${item.title} ${item.kind} ${item.text}`.toLowerCase().includes(term)));
  results.replaceChildren();
  if (!matches.length) {
    const empty = document.createElement('div');
    empty.className = 'search-empty';
    empty.textContent = 'No matching documentation.';
    results.append(empty);
    return;
  }
  for (const item of matches) {
    const link = document.createElement('a');
    link.className = 'search-result';
    link.href = `#${item.id}`;
    const title = document.createElement('strong');
    title.textContent = item.title;
    const kind = document.createElement('span');
    kind.textContent = item.kind;
    link.append(title, kind);
    link.addEventListener('click', () => dialog?.close());
    results.append(link);
  }
}

function openSearch() {
  if (!(dialog instanceof HTMLDialogElement)) return;
  renderSearch('');
  dialog.showModal();
  searchInput?.focus();
}

document.querySelector('.search-button')?.addEventListener('click', openSearch);
searchInput?.addEventListener('input', () => renderSearch(searchInput.value));
dialog?.addEventListener('click', (event) => {
  if (event.target === dialog) dialog.close();
});
document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    openSearch();
  }
});

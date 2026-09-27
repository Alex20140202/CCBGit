/* Global behaviour: theme, clipboard, toasts, small conveniences. */
(() => {
  'use strict';

  const THEME_KEY = 'ccbgit:theme';
  const THEMES = ['auto', 'light', 'dark'];

  /* ------------------------------------------------------------- theme */

  /* The stored value is applied by /js/theme.js before first paint; here we only
     need to keep localStorage and the document in step when the user changes
     it. */
  const applyTheme = (theme) => {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* private mode */ }
  };

  /** The toggle cycles auto -> light -> dark; reflect that in its tooltip. */
  const paintToggle = () => {
    const toggle = document.getElementById('theme-toggle');
    if (!toggle) return;
    const current = document.documentElement.getAttribute('data-theme') || 'auto';
    const label = { auto: 'Theme: follow system', light: 'Theme: light', dark: 'Theme: dark' }[current];
    toggle.title = `${label} — click to change`;
    toggle.setAttribute('aria-label', label);
  };
  paintToggle();

  document.addEventListener('click', (event) => {
    const toggle = event.target.closest('#theme-toggle');
    if (!toggle) return;
    const current = document.documentElement.getAttribute('data-theme') || 'auto';
    applyTheme(THEMES[(THEMES.indexOf(current) + 1) % THEMES.length]);
    paintToggle();
  });

  /* ------------------------------------------------------------ toasts */

  let toastHost = null;
  const toast = (message) => {
    if (!toastHost) {
      toastHost = document.createElement('div');
      toastHost.className = 'toast-host';
      document.body.appendChild(toastHost);
    }
    const node = document.createElement('div');
    node.className = 'toast';
    node.textContent = message;
    toastHost.replaceChildren(node);
    setTimeout(() => node.remove(), 2200);
  };

  /* --------------------------------------------------------- clipboard */

  document.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-copy-target]');
    if (!button) return;
    const selector = button.getAttribute('data-copy-target');
    const source = document.querySelector(selector);
    if (!source) return;

    const text = 'value' in source && source.value !== undefined ? source.value : source.textContent;
    const ok = await copyText(text);
    if (ok) {
      button.classList.add('is-done');
      toast('Copied to clipboard');
      setTimeout(() => button.classList.remove('is-done'), 1600);
    } else {
      toast('Copy failed — select the text manually');
    }
  });

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch { /* fall through to the legacy path */ }

    // execCommand needs a real, focused, visible element to work.
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    area.remove();
    return ok;
  }

  /* -------------------------------------------------- misc affordances */

  /* The account menu is a <details>, which has no outside-click dismissal of
     its own. */
  document.addEventListener('click', (event) => {
    const menu = event.target.closest('.user-menu');
    if (menu && !menu.contains(event.target)) menu.open = false;

    // Only one dropdown at a time.
    for (const other of document.querySelectorAll('.user-menu[open]')) {
      if (other !== menu) other.open = false;
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    for (const menu of document.querySelectorAll('.user-menu[open]')) menu.open = false;
  });

  document.addEventListener('click', (event) => {
    if (event.target.closest('[data-go-back]')) {
      if (window.history.length > 1) window.history.back();
      else window.location.assign('/');
    }
  });

  document.addEventListener('change', (event) => {
    if (event.target.matches('[data-auto-submit]')) event.target.form?.requestSubmit();
  });

  /* Rescan the repository roots without a full page navigation. */
  document.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-refresh-repos]');
    if (!button) return;
    const previous = button.textContent;
    button.disabled = true;
    button.textContent = 'Scanning…';
    try {
      const response = await fetch('/api/repos/refresh', {
        method: 'POST',
        // The session cookie alone does not authorise a state change, so the
        // CSRF token travels in a header here rather than in a form field.
        headers: csrfHeaders(),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      toast(`Indexed ${data.count} repositor${data.count === 1 ? 'y' : 'ies'}`);
      window.setTimeout(() => window.location.reload(), 500);
    } catch (error) {
      toast(`Rescan failed: ${error.message}`);
      button.disabled = false;
      button.textContent = previous;
    }
  });

  /** CSRF header for fetch() calls, read from the page's meta tag. */
  function csrfHeaders() {
    const token = document.querySelector('meta[name="csrf-token"]')?.content;
    return token ? { 'X-CSRF-Token': token } : {};
  }

  /* "/" focuses search, like every other code host. */
  document.addEventListener('keydown', (event) => {
    if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
    const active = document.activeElement;
    const typing = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);
    if (typing) return;
    event.preventDefault();
    const search = document.querySelector('.global-search input, .filter-search input');
    if (search) search.focus();
  });

  window.CCBGit = { toast, copyText };
})();

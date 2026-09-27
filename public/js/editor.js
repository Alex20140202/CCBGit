/* The in-browser file editor: line/byte counts, tab handling, submit shortcut. */
(() => {
  'use strict';

  const textarea = document.querySelector('.editor-content');
  const form = document.querySelector('.editor-form');
  if (!textarea || !form) return;

  const stats = document.querySelector('[data-editor-stats]');

  /** Rough byte count: the DOM string is UTF-16, so non-ASCII is 3-4 bytes. */
  const byteLength = (text) => {
    let bytes = 0;
    for (const char of text) {
      const code = char.codePointAt(0);
      bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    }
    return bytes;
  };

  const humanSize = (bytes) => (bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`);

  const refresh = () => {
    if (!stats) return;
    const text = textarea.value;
    const lines = text === '' ? 0 : text.split('\n').length;
    stats.textContent = `${lines} line${lines === 1 ? '' : 's'} · ${humanSize(byteLength(text))}`;
  };

  textarea.addEventListener('input', refresh);
  refresh();

  // Tab inserts a tab instead of leaving the field. Shift+Tab still escapes,
  // so the keyboard trap is not absolute.
  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Tab' && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      const { selectionStart, selectionEnd, value } = textarea;
      textarea.value = `${value.slice(0, selectionStart)}\t${value.slice(selectionEnd)}`;
      textarea.selectionStart = selectionEnd = selectionStart + 1;
      refresh();
    }
  });

  form.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      form.requestSubmit();
    }
  });
})();

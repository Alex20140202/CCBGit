/* Applies the stored theme before the first paint. Loaded synchronously from
   <head> (no defer), because a deferred script would let the light palette
   paint first and then flash over to dark. */
(() => {
  const KEY = 'ccbgit:theme';
  const VALID = ['auto', 'light', 'dark'];
  let theme = 'auto';
  try {
    const stored = localStorage.getItem(KEY);
    if (VALID.includes(stored)) theme = stored;
  } catch { /* private mode: stay on auto */ }
  document.documentElement.setAttribute('data-theme', theme);
})();

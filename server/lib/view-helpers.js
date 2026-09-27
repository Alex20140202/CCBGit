import { escapeHtml, jsonForScript, highlightLine } from './render.js';
import { formatBytes } from './languages.js';

/**
 * Helpers available to every template as `h`.
 *
 * Lives in its own module because the sign-in and admin pages render before
 * the page router installs its locals, and both need the same escaping and
 * formatting functions.
 */
export const viewHelpers = {
  escapeHtml,
  formatBytes,
  json: jsonForScript,
  highlightDiffLine: highlightLine,

  /** Escape a search hit line and wrap the match in a <mark>. */
  highlightMatch(text, index, length) {
    const value = String(text ?? '');
    if (index < 0 || length <= 0) return escapeHtml(value);
    const before = value.slice(0, index);
    const match = value.slice(index, index + length);
    const after = value.slice(index + length);
    return `${escapeHtml(before)}<mark>${escapeHtml(match)}</mark>${escapeHtml(after)}`;
  },

  /** "3 hours ago", with the exact timestamp as a tooltip elsewhere. */
  relativeTime(value) {
    if (!value) return 'unknown';
    const then = new Date(value).getTime();
    if (Number.isNaN(then)) return String(value);

    const seconds = Math.round((Date.now() - then) / 1000);
    const units = [
      ['year', 31536000], ['month', 2592000], ['day', 86400],
      ['hour', 3600], ['minute', 60], ['second', 1],
    ];
    for (const [name, size] of units) {
      const amount = Math.floor(Math.abs(seconds) / size);
      if (amount >= 1) return `${amount} ${name}${amount === 1 ? '' : 's'} ago`;
    }
    return 'just now';
  },

  /** Absolute timestamp, for tooltips. */
  timestamp(value) {
    if (!value) return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toISOString().replace('T', ' ').slice(0, 16);
  },

  /** Stable per-address avatar colour. */
  avatarColor(seed) {
    let hash = 0;
    for (const char of String(seed || '')) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return `hsl(${hash % 360} 55% 45%)`;
  },

  initials(name) {
    return String(name || '?')
      .split(/\s+/)
      .map((part) => part[0])
      .join('')
      .slice(0, 2)
      .toUpperCase();
  },

  statusLabel(status) {
    return { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied', T: 'changed' }[status] || status;
  },
};

export default viewHelpers;

import { marked } from 'marked';
import hljs from 'highlight.js';
import { languageFor } from './languages.js';

marked.setOptions({
  gfm: true,
  breaks: false,
  headerIds: false,
  mangle: false,
});

/**
 * Escape the five characters that matter in HTML text and attribute values.
 * Every piece of repository-supplied text goes through this before reaching a
 * template, because a repository may legitimately contain HTML-ish content.
 */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escape a string for embedding inside a <script type="application/json"> block. */
export function jsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * Defence in depth. `renderer.html` already escapes raw HTML, so the only
 * things left to catch are dangerous URL schemes and any tag that somehow
 * reached the output intact. Note the absence of an `on*=` handler strip: on
 * already-escaped text that regex would eat the trailing "&gt;" and mangle
 * what the reader is supposed to see.
 */
function stripDangerousHtml(html) {
  return html
    .replace(/<\s*\/?\s*(script|iframe|object|embed|link|meta|base|form|style)\b[^>]*>/gi, '')
    .replace(/javascript\s*:/gi, '');
}

/**
 * Raw HTML in a README is rendered as literal text rather than injected into
 * the page. A README is untrusted input, and the only markup we are willing to
 * emit is the markup marked itself produced, so escaping the raw-HTML token
 * stream is both simpler and safer than allow-listing tags afterwards.
 *
 * This is the single most important line in this file.
 */
const ALLOWED_URL_SCHEME = /^(https?:|mailto:|#|\/|\.\/|\.\.\/)/i;

const renderer = new marked.Renderer();

renderer.html = function html(token) {
  return escapeHtml(token.text);
};

renderer.code = function code({ text, lang }) {
  const language = guessLanguage(lang, text);
  const highlighted = highlight(text, language);
  return `<pre class="code-block" data-language="${escapeHtml(language)}"><code>${highlighted}</code></pre>\n`;
};

renderer.heading = function heading({ tokens, depth }) {
  const text = this.parser.parseInline(tokens);
  const plain = text.replace(/<[^>]+>/g, '');
  const id = slugify(plain);
  // A permalink, hidden until the heading is hovered or the link is focused.
  return `<h${depth} id="${escapeHtml(id)}" class="md-heading">${text}`
    + `<a class="md-anchor" href="#${escapeHtml(id)}" aria-label="Permalink to ${escapeHtml(plain)}">#</a>`
    + `</h${depth}>\n`;
};

renderer.link = function link({ href, title, tokens }) {
  const text = this.parser.parseInline(tokens);
  const safe = safeHref(href);
  const external = /^https?:\/\//i.test(safe || '');
  const attrs = [
    `href="${escapeHtml(safe || '#')}"`,
    title ? `title="${escapeHtml(title)}"` : '',
    external ? 'target="_blank" rel="noopener noreferrer"' : '',
  ].filter(Boolean).join(' ');
  return `<a ${attrs}>${text}</a>`;
};

renderer.image = function image({ href, title, text }) {
  const safe = safeHref(href);
  if (!/^https?:\/\//i.test(safe) && !safe.startsWith('./') && !safe.startsWith('data:image/')) {
    return `<span class="md-image-placeholder">[image: ${escapeHtml(text || safe)}]</span>`;
  }
  return `<img src="${escapeHtml(safe)}" alt="${escapeHtml(text || '')}"${title ? ` title="${escapeHtml(title)}"` : ''} loading="lazy">`;
};

/** Only allow hrefs we are willing to emit. */
function safeHref(href) {
  const value = String(href || '').trim();
  if (ALLOWED_URL_SCHEME.test(value)) return value;
  if (/^[\w.-]+\/[\w./-]*$/.test(value) && !value.startsWith('//')) return value;
  return '#';
}

function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^\w一-龥-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'section';
}

function guessLanguage(lang, text) {
  if (lang) return String(lang).toLowerCase().split(/\s+/)[0];
  return languageFor(`f.${text.includes('\t') ? 'txt' : 'txt'}`);
}

/**
 * How much text is worth handing to the content sniffer.
 *
 * `highlightAuto` runs every candidate grammar over its input, so cost grows
 * with (input size x number of grammars). On a multi-megabyte file that is
 * minutes of CPU per request, so sniffing is skipped above this size and the
 * file is rendered as plain text instead.
 */
const SNIFF_LIMIT = 24 * 1024;

/** Above this, even a known grammar is skipped: the page would be unusable. */
const HIGHLIGHT_LIMIT = 512 * 1024;

/**
 * Grammars considered by content sniffing.
 *
 * All 190-odd highlight.js grammars include obscure formats (ABNF, EBNF, DOS
 * batch, lasso) that will happily outscore a real language on a short sample.
 * Those are excluded so a guess lands on something plausible.
 */
const SNIFF_EXCLUDED = new Set([
  'plaintext', 'text', 'txt', 'plain', 'no-highlight',
  'json', 'yaml', 'xml', 'ini', 'markdown', 'csv',
  'accesslog', 'apache', 'nginx', 'makefile', 'dos', 'arduino',
  'vbscript', 'vim', 'wasm', 'irpfaxis', 'mermaid',
  'abnf', 'ebnf', 'bnf', 'lasso', 'sps', 'yacc', 'lex', 'gcode',
]);

const SNIFF_GRAMMARS = hljs.listLanguages()
  .filter((name) => hljs.getLanguage(name) && !SNIFF_EXCLUDED.has(name));

/**
 * Minimum relevance for a content guess to be believed.
 *
 * Measured on real samples: a genuine Python file scores ~22, while the
 * mis-detections (a Python file read as Ruby, Terraform read as lasso) score
 * 5-11. Anything below this is a coin flip, and a wrong language label is
 * worse than admitting the file is plain text.
 */
const SNIFF_CONFIDENCE = 15;

/**
 * Guess a language from the file's contents.
 *
 * @returns {{language: string, value: string} | null} null when no grammar
 *   scored confidently enough.
 */
export function sniff(text, { limit = SNIFF_LIMIT } = {}) {
  const source = String(text ?? '');
  if (!source.trim() || source.length > limit) return null;
  try {
    const result = hljs.highlightAuto(source, SNIFF_GRAMMARS);
    if (!result.language || result.language === 'plaintext') return null;
    if (result.relevance < SNIFF_CONFIDENCE) return null;
    return { language: result.language, value: result.value };
  } catch {
    return null;
  }
}

/**
 * Highlight source with highlight.js, falling back to content sniffing and
 * finally to escaped plain text.
 *
 * Sniffing is only attempted when the path gave us nothing, because guessing
 * from bytes is far less reliable than knowing the extension.
 */
export function highlight(code, language, { sniff: shouldSniff = true } = {}) {
  const text = String(code ?? '');

  // `plaintext` is a real highlight.js grammar, so getLanguage() happily
  // accepts it. That is exactly the case where sniffing is worth trying: the
  // path told us nothing.
  const known = language && language !== 'plaintext' && hljs.getLanguage(language);

  if (known && text.length <= HIGHLIGHT_LIMIT) {
    try {
      return hljs.highlight(text, { language, ignoreIllegals: true }).value;
    } catch {
      /* fall through to sniffing */
    }
  }

  if (known) return escapeHtml(text);

  if (shouldSniff) {
    const guess = sniff(text);
    if (guess) return guess.value;
  }

  return escapeHtml(text);
}

/** Render repository markdown to sanitized HTML. */
export function renderMarkdown(source) {
  if (!source) return '';
  let html = marked.parse(String(source), { renderer });
  html = stripDangerousHtml(html);
  return html;
}

/**
 * Highlight a single diff line. Highlighting a line in isolation cannot know
 * about a multi-line string opened on a previous line, so the result is
 * approximate - but it keeps the common case (identifiers, keywords, numbers)
 * readable without restructuring the diff into a single highlighted block.
 */
const lineCache = new Map();

export function highlightLine(text, filePath) {
  const language = languageFor(filePath || 'f.txt');
  const cacheKey = `${language} ${text}`;
  const cached = lineCache.get(cacheKey);
  if (cached !== undefined) return cached;

  let out;
  if (language === 'diff' || language === 'plaintext') {
    out = escapeHtml(text);
  } else {
    // Sniffing is explicitly off: this runs once per diff line, and the
    // auto-detector would run every grammar over each one.
    out = highlight(text, language, { sniff: false });
  }
  if (lineCache.size > 4000) lineCache.clear();
  lineCache.set(cacheKey, out);
  return out;
}

/** Plain-text one line summary of a commit body. */
export function firstLine(text, max = 120) {
  const line = String(text || '').split('\n').find((entry) => entry.trim()) || '';
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** Build an in-page table of contents from markdown headings. */
export function tableOfContents(source) {
  const headings = [];
  let inFence = false;
  for (const line of String(source || '').split('\n')) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (inFence) continue;
    const match = line.match(/^(#{1,4})\s+(.+?)\s*#*$/);
    if (match) {
      headings.push({
        depth: match[1].length,
        text: match[2].replace(/[*_`]/g, ''),
        id: slugify(match[2].replace(/[*_`]/g, '')),
      });
    }
  }
  return headings;
}

export { slugify };

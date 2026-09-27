import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { escapeHtml, highlight, jsonForScript, renderMarkdown, tableOfContents } from '../server/lib/render.js';
import { parsePatch } from '../server/lib/repo.js';

describe('escapeHtml', () => {
  test('escapes every character that can break out of markup', () => {
    assert.equal(escapeHtml('<script>'), '&lt;script&gt;');
    assert.equal(escapeHtml('a & b'), 'a &amp; b');
    assert.equal(escapeHtml('say "hi"'), 'say &quot;hi&quot;');
    assert.equal(escapeHtml("it's"), 'it&#39;s');
  });

  test('handles null and undefined', () => {
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
  });
});

describe('jsonForScript', () => {
  test('escapes characters that would break out of a script block', () => {
    const out = jsonForScript({ evil: '</script><script>alert(1)</script>' });
    assert.equal(out.includes('</script>'), false);
    assert.equal(JSON.parse(out).evil, '</script><script>alert(1)</script>');
  });
});

describe('renderMarkdown', () => {
  test('emits balanced markup', () => {
    const html = renderMarkdown('# Title\n\nSome **bold** text.\n');
    assert.match(html, /<h1 id="title" class="md-heading">Title<a class="md-anchor"/);
    // The heading is closed once, with the anchor inside it.
    assert.equal((html.match(/<\/h1>/g) || []).length, 1);
    assert.match(html, /<strong>bold<\/strong>/);
  });

  test('renders tables, lists and code fences', () => {
    const html = renderMarkdown('| a | b |\n| - | - |\n| 1 | 2 |\n');
    assert.match(html, /<table>/);
    assert.match(html, /<td>1<\/td>/);

    const list = renderMarkdown('- one\n- two\n');
    assert.match(list, /<ul>[\s\S]*<li>one<\/li>[\s\S]*<\/ul>/);
  });

  test('highlights fenced code with a known language', () => {
    const html = renderMarkdown('```js\nconst x = 1;\n```');
    assert.match(html, /class="hljs-keyword"/);
  });

  test('escapes raw HTML instead of executing it', () => {
    const html = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n');
    // The dangerous markup survives only as escaped, inert text.
    assert.equal(html.includes('<script'), false);
    assert.equal(html.includes('<img'), false);
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  });

  test('neutralises javascript: links', () => {
    const html = renderMarkdown('[click](javascript:alert(1))');
    assert.equal(html.includes('javascript:'), false);
    assert.match(html, /href="#"/);
  });

  test('gives external links noopener', () => {
    const html = renderMarkdown('[x](https://example.com)');
    assert.match(html, /rel="noopener noreferrer"/);
  });
});

describe('highlight', () => {
  test('sniffs a language it was not told, still escaping the content', () => {
    // An unknown language id no longer means "give up": the content is used to
    // guess a grammar. Whatever is chosen, the text must stay inert.
    const out = highlight('<tag>', 'not-a-real-language');
    assert.equal(out.includes('<tag>'), false);
    assert.match(out, /&lt;tag&gt;/);
  });

  test('escapes plain text when sniffing is disabled', () => {
    assert.equal(highlight('<b>&</b>', 'plaintext', { sniff: false }), '&lt;b&gt;&amp;&lt;/b&gt;');
  });

  test('highlights a known language', () => {
    assert.match(highlight('const x', 'javascript'), /hljs-keyword/);
  });
});

describe('tableOfContents', () => {
  test('collects headings and ignores fenced code', () => {
    const toc = tableOfContents('# One\n\n```\n# not a heading\n```\n\n## Two Words\n');
    assert.deepEqual(toc.map((h) => h.text), ['One', 'Two Words']);
    assert.equal(toc[1].id, 'two-words');
  });
});

describe('parsePatch', () => {
  const diff = [
    'diff --git a/a.js b/a.js',
    'index 111..222 100644',
    '--- a/a.js',
    '+++ b/a.js',
    '@@ -1,2 +1,3 @@',
    ' const x = 1;',
    '-const y = 2;',
    '+const y = 3;',
    '+const z = 4;',
    'diff --git a/new.txt b/new.txt',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/new.txt',
    '@@ -0,0 +1 @@',
    '+hello',
  ].join('\n');

  test('splits a diff into files with counts', () => {
    const { files } = parsePatch(diff);
    assert.equal(files.length, 2);
    assert.equal(files[0].additions, 2);
    assert.equal(files[0].deletions, 1);
    assert.equal(files[1].isNew, true);
    assert.equal(files[1].additions, 1);
  });

  test('numbers hunk lines correctly', () => {
    const { files } = parsePatch(diff);
    const kinds = files[0].hunks[0].lines.map((line) => line.type);
    assert.deepEqual(kinds, ['ctx', 'del', 'add', 'add']);
  });

  test('handles an empty diff', () => {
    assert.deepEqual(parsePatch('').files, []);
  });
});

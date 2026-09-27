import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import hljs from 'highlight.js';
import {
  EXTENSION_LANGUAGES,
  FILENAME_LANGUAGES,
  formatBytes,
  isDiff,
  isMarkdown,
  isProbablyText,
  isReadme,
  languageColor,
  languageFor,
} from '../server/lib/languages.js';
import { highlight, sniff } from '../server/lib/render.js';

describe('languageFor', () => {
  test('maps common extensions', () => {
    const cases = {
      'a.js': 'javascript',
      'a.mjs': 'javascript',
      'a.ts': 'typescript',
      'a.tsx': 'typescript',
      'a.py': 'python',
      'a.rb': 'ruby',
      'a.go': 'go',
      'a.rs': 'rust',
      'a.c': 'c',
      'a.cpp': 'cpp',
      'a.h': 'c',
      'a.java': 'java',
      'a.kt': 'kotlin',
      'a.swift': 'swift',
      'a.php': 'php',
      'a.sh': 'bash',
      'a.md': 'markdown',
      'a.json': 'json',
      'a.yml': 'yaml',
      'a.toml': 'ini',
      'a.sql': 'sql',
      'a.ex': 'elixir',
      'a.erl': 'erlang',
      'a.hs': 'haskell',
      'a.ml': 'ocaml',
      'a.jl': 'julia',
      // highlight.js has no Zig grammar, so this is deliberately plain text
      // rather than a misleading proxy.
      'a.zig': 'plaintext',
      'a.vhd': 'vhdl',
      'a.proto': 'protobuf',
      'a.scss': 'scss',
    };
    for (const [path, expected] of Object.entries(cases)) {
      assert.equal(languageFor(path), expected, path);
    }
  });

  test('maps by filename when there is no usable extension', () => {
    const cases = {
      Dockerfile: 'dockerfile',
      dockerfile: 'dockerfile',
      'Dockerfile.prod': 'dockerfile',
      Makefile: 'makefile',
      'CMakeLists.txt': 'cmake',
      Rakefile: 'ruby',
      Gemfile: 'ruby',
      'go.mod': 'go',
      'package.json': 'json',
      'requirements.txt': 'plaintext',
      // No grammar exists for a gitignore file; the name is what identifies it.
      '.gitignore': 'plaintext',
      '.bashrc': 'bash',
      '.zshrc': 'bash',
      'build.gradle': 'groovy',
    };
    for (const [path, expected] of Object.entries(cases)) {
      assert.equal(languageFor(path), expected, path);
    }
  });

  test('resolves compound extensions by peeling the suffix chain', () => {
    assert.equal(languageFor('types.d.ts'), 'typescript');
    assert.equal(languageFor('a.d.ts'), 'typescript');
    assert.equal(languageFor('view.blade.php'), 'php');
    assert.equal(languageFor('app.module.css'), 'css');
    assert.equal(languageFor('main.test.js'), 'javascript');
    assert.equal(languageFor('bundle.min.js'), 'javascript');
    assert.equal(languageFor('app.env.local'), 'bash');
    assert.equal(languageFor('a.b.c.py'), 'python');
  });

  test('terminates on adversarial input', () => {
    // A self-referential lookup is the failure mode this guards against: the
    // compound-extension step used to recurse forever on "x.d.ts".
    for (const path of ['a.d.ts', '.d.ts', 'a..ts', 'a.b.d.ts', '....', 'a.']) {
      assert.doesNotThrow(() => languageFor(path), path);
    }
    assert.equal(languageFor('....'), 'plaintext');
  });

  test('falls back to plaintext rather than guessing', () => {
    for (const path of ['', 'noext', 'a.weirdextension', 'a.tar.gz', 'x.']) {
      assert.equal(languageFor(path), 'plaintext', path);
    }
  });

  test('only maps onto grammars highlight.js actually has', () => {
    const bogus = new Set([...Object.values(EXTENSION_LANGUAGES), ...Object.values(FILENAME_LANGUAGES)]
      .filter((language) => language !== 'plaintext' && !hljs.getLanguage(language)));
    assert.deepEqual([...bogus], [], `unknown language ids: ${[...bogus].join(', ')}`);
  });
});

describe('isProbablyText', () => {
  test('accepts source files with unlisted extensions', () => {
    // An allow-list here would silently drop these from the statistics.
    for (const path of ['a.zig', 'a.nim', 'a.cr', 'a.weirdext', 'a', 'Makefile', 'a.q']) {
      assert.equal(isProbablyText(path), true, path);
    }
  });

  test('rejects obvious binaries', () => {
    for (const path of ['logo.png', 'a.pdf', 'a.zip', 'a.woff2', 'a.exe', 'a.so', 'a.wasm', 'a.mp4']) {
      assert.equal(isProbablyText(path), false, path);
    }
  });

  test('rejects vendored and hidden paths', () => {
    for (const path of ['node_modules/x.js', '.git/config', 'a/node_modules/b.js', '.cache/x']) {
      assert.equal(isProbablyText(path), false, path);
    }
  });
});

describe('markdown and diff detection', () => {
  test('markdown by name and extension', () => {
    for (const path of ['README.md', 'readme', 'a.markdown', 'docs/guide.mdx', 'x.MD']) {
      assert.equal(isMarkdown(path), true, path);
    }
    for (const path of ['a.txt', 'a.js']) {
      assert.equal(isMarkdown(path), false, path);
    }
  });

  test('readme only by name', () => {
    assert.equal(isReadme('docs/README.md'), true);
    assert.equal(isReadme('src/readme_helper.js'), false);
  });

  test('patch files', () => {
    assert.equal(isDiff('a.patch'), true);
    assert.equal(isDiff('a.diff'), true);
    assert.equal(isDiff('a.js'), false);
  });
});

describe('highlight', () => {
  test('highlights when the extension is known', () => {
    const out = highlight('const x = 1;', 'javascript');
    assert.match(out, /hljs-keyword/);
  });

  test('sniffs the content when the path says nothing', () => {
    const python = [
      'import os',
      'import sys',
      '',
      'class Greeter:',
      '    def __init__(self, name: str) -> None:',
      '        self.name = name',
      '',
      '    def greet(self) -> str:',
      '        return f"hello {self.name}"',
      '',
      '    @property',
      '    def upper(self) -> str:',
      '        return self.name.upper()',
      '',
      'if __name__ == "__main__":',
      '    print(Greeter(sys.argv[1]).greet())',
    ].join('\n');
    // "plaintext" is a real grammar, so this exercises the fallback that a
    // naive `getLanguage()` check skips.
    const out = highlight(python, languageFor('script.unknownext'));
    assert.match(out, /hljs-/);
  });

  test('refuses to guess rather than mislabel', () => {
    // Terraform has no highlight.js grammar. A low-confidence guess here would
    // be reported as some unrelated language, which is worse than plain text.
    const terraform = [
      'resource "aws_s3_bucket" "b" {',
      '  bucket = var.name',
      '  acl    = "private"',
      '}',
    ].join('\n');
    assert.equal(sniff(terraform), null);
  });

  test('an unidentified file is rendered as plain text, not mislabelled', () => {
    const terraform = 'resource "aws_s3_bucket" "b" {\n  bucket = var.name\n}\n';
    const out = highlight(terraform, 'plaintext');
    assert.equal(out.includes('hljs-'), false);
  });

  test('escapes plain text it cannot classify', () => {
    assert.equal(highlight('<b>&</b>', 'plaintext', { sniff: false }), '&lt;b&gt;&amp;&lt;/b&gt;');
  });

  test('never emits unescaped markup for hostile content', () => {
    const out = highlight('<script>alert(1)</script>', 'javascript');
    assert.equal(out.includes('<script'), false);
  });

  test('gives up on a large unknown file instead of sniffing it', () => {
    // highlightAuto runs every grammar over the input. Without a size cap this
    // single call takes minutes, so it must bail out early.
    const big = 'lorem ipsum dolor sit amet '.repeat(4000); // ~108 KB
    const started = process.hrtime.bigint();
    const out = highlight(big, 'plaintext');
    const ms = Number(process.hrtime.bigint() - started) / 1e6;

    assert.equal(out.includes('hljs-'), false, 'should not have highlighted');
    assert.equal(ms < 2000, true, `took ${ms.toFixed(0)}ms, expected under 2000ms`);
  });

  test('a large file with a known language still highlights', () => {
    const big = 'const x = 1;\n'.repeat(20000); // ~280 KB
    const out = highlight(big, 'javascript');
    assert.match(out, /hljs-keyword/);
  });
});

describe('formatBytes', () => {
  test('scales and rounds sensibly', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(1024), '1 KB');
    assert.equal(formatBytes(1536), '1.5 KB');
    assert.equal(formatBytes(1024 ** 3 * 2), '2 GB');
    assert.equal(formatBytes(undefined), '0 B');
  });
});

describe('languageColor', () => {
  test('is stable and always a colour', () => {
    assert.equal(languageColor('javascript'), languageColor('javascript'));
    assert.notEqual(languageColor('javascript'), languageColor('python'));
    for (const name of ['javascript', 'ruby', '', 'x'.repeat(200)]) {
      assert.match(languageColor(name), /^#[0-9a-f]{6}$/, name);
    }
  });
});

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  ValidationError,
  assertCommitish,
  assertRepoName,
  assertSafeRef,
  assertSha,
  isInside,
  parsePage,
  safeRepoPath,
} from '../server/lib/validate.js';

describe('assertRepoName', () => {
  test('accepts ordinary names', () => {
    for (const name of ['hello-node', 'a', 'my_repo', 'repo.js', 'A1']) {
      assert.equal(assertRepoName(name), name);
    }
  });

  test('rejects traversal and separators', () => {
    for (const name of ['..', '.', '../etc', 'a/b', '', '.hidden', 'a b', 'a;b']) {
      assert.throws(() => assertRepoName(name), ValidationError, `should reject ${JSON.stringify(name)}`);
    }
  });
});

describe('assertSafeRef', () => {
  test('accepts branches, tags and shas', () => {
    for (const ref of ['main', 'feature/body-limit', 'v1.0.0', 'release-2', 'a1b2c3d']) {
      assert.equal(assertSafeRef(ref), ref);
    }
  });

  test('rejects anything git could read as an option or a range', () => {
    const hostile = [
      '--upload-pack=evil',
      '-x',
      'main..evil',
      'HEAD^',
      'HEAD~1',
      '@{-1}',
      'main:file',
      'with space',
      'a\\b',
      'main*',
      'ref?x',
      'a//b',
      'a'.repeat(300),
    ];
    for (const ref of hostile) {
      assert.throws(() => assertSafeRef(ref), ValidationError, `should reject ${ref}`);
    }
  });

  test('empty is allowed unless a ref is required', () => {
    assert.equal(assertSafeRef(''), '');
    assert.throws(() => assertSafeRef('', { allowEmpty: false }), ValidationError);
    assert.throws(() => assertSafeRef(undefined, { allowEmpty: false }), ValidationError);
  });
});

describe('assertSha / assertCommitish', () => {
  test('accepts shas and lowercases them', () => {
    assert.equal(assertSha('ABC1234'), 'abc1234');
  });

  test('assertCommitish also allows refs', () => {
    assert.equal(assertCommitish('ABC1234'), 'abc1234');
    assert.equal(assertCommitish('HEAD'), 'HEAD');
    assert.equal(assertCommitish('main'), 'main');
  });

  test('still rejects option-like commit-ish values', () => {
    assert.throws(() => assertCommitish('--all'), ValidationError);
    assert.throws(() => assertCommitish('a..b'), ValidationError);
  });
});

describe('safeRepoPath', () => {
  test('normalises redundant separators', () => {
    assert.equal(safeRepoPath('/src//index.js'), 'src/index.js');
    assert.equal(safeRepoPath('./src/index.js'), 'src/index.js');
    assert.equal(safeRepoPath('src/index.js'), 'src/index.js');
    assert.equal(safeRepoPath(''), '');
  });

  test('rejects traversal in any position', () => {
    for (const input of ['../etc/passwd', 'src/../../etc/passwd', 'a/b/../../../c', '..']) {
      assert.throws(() => safeRepoPath(input), ValidationError, `should reject ${input}`);
    }
  });

  test('rejects NUL bytes', () => {
    assert.throws(() => safeRepoPath('src/\u0000.js'), ValidationError);
  });

  test('keeps dots that are part of a name', () => {
    assert.equal(safeRepoPath('src/.gitignore'), 'src/.gitignore');
    assert.equal(safeRepoPath('a..b'), 'a..b');
  });
});

describe('parsePage', () => {
  test('falls back and clamps', () => {
    assert.equal(parsePage(undefined, 1, 10), 1);
    assert.equal(parsePage('abc', 1, 10), 1);
    assert.equal(parsePage('0', 1, 10), 1);
    assert.equal(parsePage('-3', 1, 10), 1);
    assert.equal(parsePage('99', 1, 10), 10);
    assert.equal(parsePage('5', 1, 10), 5);
  });
});

describe('isInside', () => {
  test('detects containment and escapes', () => {
    assert.equal(isInside('/srv/repos', '/srv/repos/child'), true);
    assert.equal(isInside('/srv/repos', '/srv/repos'), true);
    assert.equal(isInside('/srv/repos', '/srv/other'), false);
    assert.equal(isInside('/srv/repos', '/srv/repos/../other'), false);
  });
});

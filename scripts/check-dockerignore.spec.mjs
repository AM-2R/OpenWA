import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * The gate resolves its root from its own location, so each case copies the script into a throwaway
 * root next to a Dockerfile and a .dockerignore of its own and runs that copy. The repository's files
 * are only read.
 *
 * The Dockerfile COPYs its patchers by name. A .dockerignore rule that drops one still printed OK
 * while the gate asserted only a hand-picked few, and the break surfaced later as a COPY failure in
 * the multi-arch docker job.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GATE = join(ROOT, 'scripts', 'check-dockerignore.mjs');
const REAL_DOCKERFILE = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
const REAL_DOCKERIGNORE = readFileSync(join(ROOT, '.dockerignore'), 'utf8');

/** Run a copy of the gate in a fresh root holding `files`; `files` maps a relative path to its text. */
function runGate(files) {
  const root = mkdtempSync(join(tmpdir(), 'openwa-dockerignore-'));
  try {
    mkdirSync(join(root, 'scripts'));
    copyFileSync(GATE, join(root, 'scripts', 'check-dockerignore.mjs'));
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    const run = spawnSync(process.execPath, [join(root, 'scripts', 'check-dockerignore.mjs')], { encoding: 'utf8' });
    return { status: run.status, out: `${run.stdout}${run.stderr}` };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const withRule = rule => ({ Dockerfile: REAL_DOCKERFILE, '.dockerignore': `${REAL_DOCKERIGNORE}\n${rule}\n` });

test('the repository passes its own gate', () => {
  const run = runGate({ Dockerfile: REAL_DOCKERFILE, '.dockerignore': REAL_DOCKERIGNORE });
  assert.equal(run.status, 0, run.out);
});

test('a rule that drops any patcher the Dockerfile copies fails the gate', () => {
  const patchers = readdirSync(join(ROOT, 'scripts')).filter(
    name => name.startsWith('patch-') && name.endsWith('.js') && !name.endsWith('.spec.js'),
  );
  // Non-vacuity: an empty directory scan would pass every assertion below.
  assert.ok(patchers.length >= 10, `expected the patchers to be found, saw ${patchers.length}`);
  for (const patcher of patchers) {
    const run = runGate(withRule(`scripts/${patcher}`));
    assert.equal(run.status, 1, `${patcher} is dropped by a rule and the gate passed`);
    assert.match(run.out, new RegExp(`rejects 'scripts/${patcher.replaceAll('.', '\\.')}'`), run.out);
  }
});

test('a source spelled ./x, /x, x//y or x/./y, or read by ADD, is the same build input as x', () => {
  // Docker resolves each spelling to one path in the context, which is the form the rules match.
  const sources = ['scripts/new.js', './scripts/new.js', '/scripts/new.js', 'scripts//new.js', 'scripts/./new.js'];
  for (const instruction of ['COPY', 'ADD']) {
    for (const source of sources) {
      const run = runGate({
        // The first line is a control, so that a gate which reads no ADD fails on the missing report and
        // not on having found no source at all.
        Dockerfile: `COPY control.txt ./\n${instruction} ${source} ./scripts/\n`,
        '.dockerignore': `${REAL_DOCKERIGNORE}\nscripts/new.js\n`,
      });
      assert.equal(run.status, 1, `${instruction} ${source} is dropped by a rule and the gate passed`);
      assert.match(run.out, /rejects 'scripts\/new\.js'/, `${instruction} ${source}: ${run.out}`);
    }
  }
});

test('a wildcard COPY source is expanded against the tree', () => {
  const run = runGate({
    Dockerfile: 'COPY pkg-*.txt ./\n',
    'pkg-a.txt': '',
    'pkg-b.txt': '',
    '.dockerignore': `${REAL_DOCKERIGNORE}\npkg-b.txt\n`,
  });
  assert.equal(run.status, 1, run.out);
  assert.match(run.out, /rejects 'pkg-b\.txt'/);
  assert.doesNotMatch(run.out, /rejects 'pkg-a\.txt'/);
});

test('a COPY from another stage, a flag and the destination are not build inputs', () => {
  const dockerfile = [
    'COPY --chown=openwa:openwa scripts/lib-env.sh ./scripts/',
    'COPY --from=builder /app/dist ./dist',
    'COPY . .',
    '',
  ].join('\n');
  // dist/ is rejected by the real .dockerignore, so counting the stage copy's source or the
  // destination would fail this run.
  const run = runGate({ Dockerfile: dockerfile, '.dockerignore': REAL_DOCKERIGNORE });
  assert.equal(run.status, 0, run.out);
});

test('a Dockerfile with no COPY source fails instead of passing for lack of input', () => {
  const run = runGate({ Dockerfile: 'FROM scratch\n', '.dockerignore': REAL_DOCKERIGNORE });
  assert.equal(run.status, 1, run.out);
  assert.match(run.out, /COPY/);
});

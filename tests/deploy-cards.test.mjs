import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const source = fs.readFileSync('scripts/deploy.sh', 'utf8');

// Run the real deployment through its Cards step, with real isolated Git history.
// Package/DB operations are inert; stop before any service restart or HTTP probe.
function deployFixture(t, { change = 'ric', installed = true, dirty = false, target = 'prod' } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'openln-deploy-cards-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const repo = path.join(home, 'openln');
  const shop = path.join(home, 'maekob');
  const bin = path.join(home, 'bin');
  const calls = path.join(home, 'installer-calls');
  const write = (name, body) => {
    fs.mkdirSync(path.dirname(name), { recursive: true });
    fs.writeFileSync(name, body);
  };
  function git(cwd, ...args) {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  function init(dir) {
    fs.mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.name', 'Deploy test');
    git(dir, 'config', 'user.email', 'deploy-test@example.invalid');
  }
  function commit(dir, message) {
    git(dir, 'add', '.');
    git(dir, '-c', 'commit.gpgsign=false', 'commit', '-qm', message);
    return git(dir, 'rev-parse', 'HEAD');
  }
  init(repo);
  write(path.join(repo, '.gitignore'), 'artifacts/api-server/.env\nartifacts/cards-shop/\n');
  write(path.join(repo, 'artifacts/api-server/.env'), 'DATABASE_URL=offline-fixture\nSESSION_SECRET=offline-fixture\n');
  write(path.join(repo, 'artifacts/cards-shop-release.json'), '{"archive":"cards-shop-release.tar.gz","sourceCommit":"old-cards"}\n');
  write(path.join(repo, 'artifacts/cards-shop-release.tar.gz'), 'fixture archive v1');
  write(path.join(repo, 'migrations/001.sql'), '-- offline fixture\n');
  write(path.join(repo, 'scripts/install-cards-shop.py'), `import os, pathlib, sys
with pathlib.Path(os.environ['CARDS_TEST_CALLS']).open('a') as output:
    output.write(sys.argv[1] + '\\n')
if os.environ['CARDS_TEST_DIRTY'] == '1':
    raise SystemExit('Cards source DRIFT; refusing deploy')
`);
  const before = commit(repo, 'initial release');
  if (change === 'ric') write(path.join(repo, 'ric-fix.txt'), 'unrelated RIC release\n');
  if (change === 'manifest') write(path.join(repo, 'artifacts/cards-shop-release.json'), '{"archive":"cards-shop-release.tar.gz","sourceCommit":"new-cards"}\n');
  if (change === 'archive') write(path.join(repo, 'artifacts/cards-shop-release.tar.gz'), 'fixture archive v2');
  if (change !== 'same') commit(repo, 'candidate release');
  git(repo, 'branch', 'candidate');
  git(repo, 'reset', '--hard', before);
  git(repo, 'remote', 'add', 'origin', repo);

  init(shop);
  write(path.join(shop, 'tracked-source.txt'), 'existing Cards source\n');
  // Stale metadata must not trigger installation, nor should a missing marker.
  write(path.join(shop, '.cards-ui-deployed'), '93b10ace9116dae19dfd8fee6b5213b60fa0c485 old-artifact\n');
  commit(shop, 'existing shop');
  if (dirty) fs.unlinkSync(path.join(shop, 'tracked-source.txt'));
  const staticRoot = target === 'prod'
    ? path.join(shop, 'artifacts/maekob-shop/dist/public')
    : path.join(repo, 'artifacts/cards-shop/current/public');
  if (installed) write(path.join(staticRoot, 'index.html'), 'hand-deployed Cards UI, keep untouched\n');
  const shopBefore = git(shop, 'status', '--porcelain');
  for (const command of ['pnpm', 'psql']) {
    write(path.join(bin, command), '#!/bin/sh\nprintf "offline fixture\\n"\n');
    fs.chmodSync(path.join(bin, command), 0o755);
  }
  const stop = source.indexOf('\nlog "restart"');
  assert.ok(stop > 0, 'test must stop before restarting any service');
  const script = source.slice(0, stop)
    .replaceAll('/opt/openln', repo)
    .replaceAll('/opt/maekob', shop);
  const result = spawnSync('bash', ['-s', target], {
    input: script,
    cwd: repo,
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, OPENLN_BRANCH: 'candidate', CARDS_TEST_CALLS: calls, CARDS_TEST_DIRTY: dirty ? '1' : '0' },
  });
  assert.equal(git(shop, 'status', '--porcelain'), shopBefore, 'Cards checkout must remain untouched');
  if (installed) assert.equal(fs.readFileSync(path.join(staticRoot, 'index.html'), 'utf8'), 'hand-deployed Cards UI, keep untouched\n');
  return { ...result, calls: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : [] };
}

test('unrelated RIC release never invokes Cards installer even with dirty hand-deployed Cards and stale marker', t => {
  for (const change of ['ric', 'same']) {
    const result = deployFixture(t, { change, dirty: true });
    assert.deepEqual(result.calls, [], result.stderr);
    assert.equal(result.status, 0, result.stderr);
  }
});

test('changed pinned Cards manifest or archive invokes the installer through deploy', t => {
  for (const change of ['manifest', 'archive']) {
    const result = deployFixture(t, { change });
    assert.deepEqual(result.calls, ['prod'], result.stderr);
    assert.equal(result.status, 0, result.stderr);
  }
});

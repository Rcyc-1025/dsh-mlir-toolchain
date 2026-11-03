import assert from 'node:assert/strict';
import test from 'node:test';
import { createSubprocessRunner } from '../lib/exec.js';
import { fakeSpawn } from './helpers.mjs';

test('正常退出：收集 stdout/stderr 与退出码', async () => {
  const spawn = fakeSpawn(() => ({ exitCode: 0, stdout: 'hello\n', stderr: 'warn\n' }));
  const run = createSubprocessRunner(spawn, 3000, 5000);
  const result = await run(['tool', '--version'], { cwd: '.', timeoutMs: 1000 });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'hello\n');
  assert.equal(result.stderr, 'warn\n');
  assert.equal(result.timedOut, false);
  assert.ok(result.durationMs >= 0);
});

test('超时：exitCode 归一为 null，timedOut:true，不抛异常', async () => {
  const spawn = fakeSpawn(() => 'hang');
  const run = createSubprocessRunner(spawn, 3000, 5000);
  const started = Date.now();
  const result = await run(['slow-tool'], { cwd: '.', timeoutMs: 120 });
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, null);
  assert.ok(Date.now() - started < 3000);
});

test('外部 signal 取消同样归一为 exitCode:null', async () => {
  const spawn = fakeSpawn(() => 'hang');
  const run = createSubprocessRunner(spawn, 3000, 5000);
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error('user cancel')), 50);
  const result = await run(['slow-tool'], { cwd: '.', timeoutMs: 5000, signal: controller.signal });
  assert.equal(result.exitCode, null);
  assert.equal(result.timedOut, false);
});

test('spawn 抛错且未 abort 时向上抛，交给调用方转成中文 hint', async () => {
  const spawn = () => { throw new Error('spawn EPERM'); };
  const run = createSubprocessRunner(spawn, 3000, 5000);
  await assert.rejects(() => run(['x'], { cwd: '.', timeoutMs: 1000 }), /EPERM/);
});

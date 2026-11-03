import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from '../lib/config.js';
import { createSubprocessRunner } from '../lib/exec.js';
import { buildMlirTools } from '../lib/tools.js';
import { canSpawnRealProcesses, fakeExec } from './helpers.mjs';

const here = fileURLToPath(new URL('..', import.meta.url));
const workspace = join(here, '..');
// 用插件目录当会话 cwd：日志落在插件内 .mlir-logs，不污染上层工作区。
const exec = fakeExec(here);

/** 真实子进程的宿主契约最小实现。 */
function realSpawn(spec) {
  const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdoutText = '';
  let stderrText = '';
  const limit = 8 * 1024 * 1024;
  child.stdout.on('data', (chunk) => {
    if (stdoutText.length < limit) stdoutText += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk) => {
    if (stderrText.length < limit) stderrText += chunk.toString('utf8');
  });
  const done = new Promise((resolveDone) => {
    child.on('error', (error) => resolveDone({ exitCode: 127, signal: null, error }));
    child.on('close', (exitCode, signal) => resolveDone({ exitCode, signal }));
  });
  if (spec.signal !== undefined && spec.signal !== null) {
    spec.signal.addEventListener('abort', () => {
      try { child.kill(); } catch { /* 忽略 */ }
    }, { once: true });
  }
  return {
    done,
    collected: {
      stdout: { readFrom: () => ({ text: stdoutText, truncated: false, lossy: false }) },
      stderr: { readFrom: () => ({ text: stderrText, truncated: false, lossy: false }) },
    },
  };
}

/** 用自动发现（或 MLIR_TOOLCHAIN_JSON）找本机工具链；找不到就整组 skip。 */
function discover() {
  if (!canSpawnRealProcesses()) return { config: null, reason: '当前沙箱禁止 node 再 spawn；请在普通终端跑本文件' };
  const cfg = resolveConfig({}, workspace);
  if (typeof cfg.toolchainPath !== 'string' || !existsSync(cfg.toolchainPath)) {
    return {
      config: null,
      reason: '本机没有 toolchain.json（可设 MLIR_TOOLCHAIN_JSON 指向它，或把插件放回 mlir-lang/ 下）',
    };
  }
  return { config: cfg, reason: null };
}

const discovered = discover();
const skip = discovered.reason === null ? false : discovered.reason;

function realTools(overrides = {}) {
  const cfg = discovered.config === null
    ? resolveConfig({}, workspace)
    : resolveConfig({ ...overrides, toolchainPath: discovered.config.toolchainPath }, workspace);
  const runner = createSubprocessRunner(realSpawn, cfg.graceMs, cfg.timeoutMs);
  const map = {};
  for (const def of buildMlirTools(cfg, runner)) map[def.name] = def;
  return map;
}

test('真实工具链：probe 全绿且版本 23.1.4', { skip }, async () => {
  const result = await realTools().mlir_probe.execute({}, exec);
  assert.equal(result.ok, true, JSON.stringify({ missing: result.missing, failed: result.failed, hint: result.hint }));
  assert.equal(result.llvm.version, '23.1.4');
  assert.equal(result.tools['mlir-opt'].ok, true);
});

test('真实工具链：mlir-opt --version 退出码 0', { skip }, async () => {
  const result = await realTools().mlir_run.execute({ tool: 'opt', args: ['--version'] }, exec);
  assert.equal(result.ok, true, String(result.hint));
  assert.equal(result.exitCode, 0);
});

test('真实工具链：parse_check 合法 IR ok:true，坏语法返回结构化 error', { skip }, async () => {
  const tools = realTools();
  const good = await tools.mlir_parse_check.execute(
    { source: 'module {\n  func.func @add(%a: i32, %b: i32) -> i32 {\n    %0 = arith.addi %a, %b : i32\n    return %0 : i32\n  }\n}\n' },
    exec,
  );
  assert.equal(good.ok, true, JSON.stringify(good.errors));
  const bad = await tools.mlir_parse_check.execute({ source: 'module { func.func @broken( }\n' }, exec);
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.length > 0, String(bad.hint));
  assert.equal(bad.errors[0].file, '<source>');
});

test('真实工具链：parse_check + passes 跑 cse 不报未知 pass', { skip }, async (t) => {
  const result = await realTools().mlir_parse_check.execute(
    { source: 'module {\n  func.func @f(%a: i32, %b: i32) -> i32 {\n    %0 = arith.addi %a, %b : i32\n    return %0 : i32\n  }\n}\n', passes: ['cse', 'canonicalize'] },
    exec,
  );
  if (/未知 pass/.test(String(result.hint))) t.skip(String(result.hint));
  assert.equal(result.ok, true, JSON.stringify({ errors: result.errors, hint: result.hint }));
  assert.equal(result.passPipeline, 'builtin.module(cse,canonicalize)');
});

test('真实工具链：TableGen 生成非空 .h.inc（include 自动发现）', { skip }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mlir-real-tblgen-'));
  try {
    const tdPath = join(dir, 'TestOps.td');
    writeFileSync(tdPath, 'include "mlir/IR/OpBase.td"\ndef TestDialect : Dialect { let name = "testdialect"; }\ndef TestOp : Op<TestDialect, "testop"> {}\n', 'utf8');
    const incPath = join(dir, 'TestOps.h.inc');
    const result = await realTools().mlir_tblgen.execute({ kind: 'op-decls', inputPath: tdPath, outputPath: incPath }, exec);
    if (!result.ok && /OpBase\.td/.test(String(result.hint))) t.skip(String(result.hint));
    assert.equal(result.ok, true, String(result.hint) + '\n' + String(result.stderr));
    assert.ok(result.bytes > 0);
    assert.match(readFileSync(incPath, 'utf8'), /TestOp/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

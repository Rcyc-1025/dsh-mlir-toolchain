// 真机冒烟：在普通终端（非 DSH 沙箱）里跑，验证四个工具对本机 23.1.4 工具链的真实行为。
//   node test/smoke.mjs [toolchain.json 路径]
// 退出码：0 全过；1 有用例失败；2 没找到 toolchain.json。
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig } from '../lib/config.js';
import { createSubprocessRunner } from '../lib/exec.js';
import { buildMlirTools } from '../lib/tools.js';

const cwd = process.cwd();
const explicit = process.argv[2];
const config = resolveConfig(explicit === undefined ? {} : { toolchainPath: explicit }, cwd);
if (typeof config.toolchainPath !== 'string' || !existsSync(config.toolchainPath)) {
  console.error('✗ 没找到 toolchain.json：' + String(config.toolchainPath));
  console.error('  用法：node test/smoke.mjs D:\\path\\to\\toolchain.json，或设环境变量 MLIR_TOOLCHAIN_JSON。');
  process.exit(2);
}

/** 真实子进程宿主契约（与 test/integration.test.mjs 相同）。 */
function realSpawn(spec) {
  const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdoutText = '';
  let stderrText = '';
  const limit = 8 * 1024 * 1024;
  child.stdout.on('data', (chunk) => { if (stdoutText.length < limit) stdoutText += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { if (stderrText.length < limit) stderrText += chunk.toString('utf8'); });
  const done = new Promise((resolveDone) => {
    child.on('error', (error) => resolveDone({ exitCode: 127, signal: null, error }));
    child.on('close', (exitCode, signal) => resolveDone({ exitCode, signal }));
  });
  if (spec.signal !== undefined && spec.signal !== null) {
    spec.signal.addEventListener('abort', () => { try { child.kill(); } catch { /* 忽略 */ } }, { once: true });
  }
  return {
    done,
    collected: {
      stdout: { readFrom: () => ({ text: stdoutText, truncated: false, lossy: false }) },
      stderr: { readFrom: () => ({ text: stderrText, truncated: false, lossy: false }) },
    },
  };
}

const runner = createSubprocessRunner(realSpawn, config.graceMs, config.timeoutMs);
const tools = {};
for (const tool of buildMlirTools(config, runner)) tools[tool.name] = tool;
const exec = { agent: { session: { header: { cwd } } } };

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log((ok ? '✔ ' : '✗ ') + name + (detail === undefined || detail === '' ? '' : ' — ' + detail));
}

const probe = await tools.mlir_probe.execute({}, exec);
check('probe 全绿（' + String(probe.llvm?.version) + '）', probe.ok === true, probe.ok === true ? '' : String(probe.hint));
if (Array.isArray(probe.versionMismatch) && probe.versionMismatch.length > 0) {
  console.log('  ⚠ 版本不一致：' + JSON.stringify(probe.versionMismatch));
}
if (probe.tblgenInclude !== undefined) {
  console.log('  TableGen include：' + probe.tblgenInclude.source + ' → ' + (probe.tblgenInclude.dirs.join('、') || '（无）'));
}

const version = await tools.mlir_run.execute({ tool: 'mlir-opt', args: ['--version'] }, exec);
check('mlir_run mlir-opt --version 退出码 0', version.ok === true && version.exitCode === 0, String(version.hint ?? ''));

const good = await tools.mlir_parse_check.execute({
  source: 'module {\n  func.func @add(%a: i32, %b: i32) -> i32 {\n    %0 = arith.addi %a, %b : i32\n    return %0 : i32\n  }\n}\n',
}, exec);
check('parse_check 合法 IR 通过', good.ok === true, JSON.stringify(good.errors));

const bad = await tools.mlir_parse_check.execute({ source: 'module { func.func @broken( }\n' }, exec);
check('parse_check 坏语法返回结构化 error', bad.ok === false && bad.errors.length > 0 && bad.errors[0].file === '<source>',
  bad.errors.length > 0 ? 'line ' + String(bad.errors[0].line) : String(bad.hint));

const passed = await tools.mlir_parse_check.execute({
  source: 'module {\n  func.func @f(%a: i32, %b: i32) -> i32 {\n    %0 = arith.addi %a, %b : i32\n    return %0 : i32\n  }\n}\n',
  passes: ['cse', 'canonicalize'],
}, exec);
check('parse_check 跑 cse,canonicalize 通过', passed.ok === true, String(passed.hint ?? ''));

const dir = mkdtempSync(join(tmpdir(), 'dsh-mlir-smoke-'));
try {
  const tdPath = join(dir, 'SmokeOps.td');
  writeFileSync(tdPath, 'include "mlir/IR/OpBase.td"\ndef SmokeDialect : Dialect { let name = "smokedialect"; }\ndef SmokeOp : Op<SmokeDialect, "smokeop"> {}\n', 'utf8');
  const incPath = join(dir, 'SmokeOps.h.inc');
  const tblgen = await tools.mlir_tblgen.execute({ kind: 'op-decls', inputPath: tdPath, outputPath: incPath }, exec);
  const ok = tblgen.ok === true && tblgen.bytes > 0 && readFileSync(incPath, 'utf8').includes('SmokeOp');
  check('tblgen op-decls（include 自动发现）', ok, 'include=' + String(tblgen.includeSource) + '，' + String(tblgen.bytes) + ' 字节' + (ok ? '' : '：' + String(tblgen.hint)));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const failed = results.filter((item) => !item.ok);
console.log('\n' + (failed.length === 0 ? '全部通过' : '失败 ' + String(failed.length) + ' 项') + '（' + String(results.length) + ' 项）');
process.exit(failed.length === 0 ? 0 : 1);

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { resolveConfig } from '../lib/config.js';
import { createSubprocessRunner } from '../lib/exec.js';
import { apply } from '../lib/index.js';
import { buildMlirTools } from '../lib/tools.js';
import { fakeRunner, makeFixture } from './fixtures.mjs';
import { fakeExec, fakeSpawn } from './helpers.mjs';

const VERSION_TEXT = 'LLVM (http://llvm.org/):\n  LLVM version 23.1.4\n  Optimized build.\n';

/** 本仓库布局：插件目录的上一级就是 mlir-lang，旁边放 toolchain.json。 */
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SIBLING_TOOLCHAIN = join(PACKAGE_ROOT, '..', 'toolchain.json');

function makeMap(defs) {
  const map = {};
  for (const def of defs) map[def.name] = def;
  return map;
}

/** 用 fixture 造一套工具；responder 默认对任何工具都回 23.1.4。 */
function buildWith(fixture, overrides = {}, responder = () => ({ stdout: VERSION_TEXT })) {
  const cfg = resolveConfig({ toolchainPath: fixture.toolchainPath, ...overrides }, fixture.dir);
  const runner = fakeRunner(responder);
  return { tools: makeMap(buildMlirTools(cfg, runner)), calls: runner.calls, cfg };
}

function logFiles(dir) {
  const logsDir = join(dir, '.mlir-logs');
  return existsSync(logsDir) ? readdirSync(logsDir).filter((name) => name.endsWith('.log')) : [];
}

test('probe：并行探测、版本解析、ok:true 且来源 toolchain.json', async () => {
  const fixture = makeFixture();
  try {
    const built = buildWith(fixture);
    const result = await built.tools.mlir_probe.execute({}, fakeExec(fixture.dir));
    assert.equal(result.ok, true, JSON.stringify(result.missing));
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.failed, []);
    assert.equal(result.source, 'toolchain.json');
    assert.equal(result.llvm.version, '23.1.4');
    assert.equal(result.tools['mlir-opt'].version, '23.1.4');
    // 只探测存在的工具；不存在的不 spawn。
    assert.equal(built.calls.length, 4);
    for (const call of built.calls) assert.deepEqual(call.argv.slice(1), ['--version']);
  } finally {
    fixture.cleanup();
  }
});

test('probe：versionMismatch 标出与 toolchain.json 声明不一致的工具', async () => {
  const fixture = makeFixture({ versions: { 'mlir-opt': '22.0.0' } });
  try {
    const built = buildWith(fixture);
    const result = await built.tools.mlir_probe.execute({}, fakeExec(fixture.dir));
    assert.equal(result.ok, true);
    assert.equal(result.versionMismatch.length, 1);
    assert.deepEqual(result.versionMismatch[0], { name: 'mlir-opt', declared: '22.0.0', actual: '23.1.4' });
  } finally {
    fixture.cleanup();
  }
});

test('probe：工具存在但 --version 失败 → failed 而非 missing', async () => {
  const fixture = makeFixture();
  try {
    const built = buildWith(fixture, {}, (argv) => (argv[0].includes('mlir-opt')
      ? { exitCode: 1, stderr: 'boom' }
      : { stdout: VERSION_TEXT }));
    const result = await built.tools.mlir_probe.execute({}, fakeExec(fixture.dir));
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.failed, ['mlir-opt']);
    assert.match(String(result.hint), /mlir-opt/);
  } finally {
    fixture.cleanup();
  }
});

test('零配置：插件包同级优先，没有时回退 cwd/toolchain.json', () => {
  const fixture = makeFixture();
  try {
    const cfg = resolveConfig({}, fixture.dir);
    assert.equal(cfg.toolchainPath, existsSync(SIBLING_TOOLCHAIN) ? SIBLING_TOOLCHAIN : fixture.toolchainPath);
  } finally {
    fixture.cleanup();
  }
});

test('运行时兜底：加载期没发现时按会话 cwd 重新发现（本仓布局先命中包同级）', async () => {
  const fixture = makeFixture();
  try {
    const empty = join(fixture.dir, 'empty');
    mkdirSync(empty, { recursive: true });
    const cfg = resolveConfig({}, empty);
    // 本仓库里插件包同级就有 toolchain.json，加载期必然找到；强制清空以模拟
    // “部署时没找到”，验证每次执行按会话 cwd 的兜底发现。
    cfg.toolchainPath = null;
    const runner = fakeRunner(() => ({ stdout: VERSION_TEXT }));
    const tools = makeMap(buildMlirTools(cfg, runner));
    const result = await tools.mlir_probe.execute({}, fakeExec(fixture.dir));
    assert.equal(result.ok, true, JSON.stringify(result.missing));
    assert.equal(result.toolchainPath, existsSync(SIBLING_TOOLCHAIN) ? SIBLING_TOOLCHAIN : fixture.toolchainPath);
    assert.equal(result.source, 'toolchain.json');
  } finally {
    fixture.cleanup();
  }
});

test('显式 toolchainPath 优先于自动发现', () => {
  const fixture = makeFixture();
  try {
    const explicit = join(fixture.dir, 'nope', 'custom.json');
    const cfg = resolveConfig({ toolchainPath: explicit }, fixture.dir);
    assert.equal(cfg.toolchainPath, explicit);
  } finally {
    fixture.cleanup();
  }
});

test('mlir_run：返回 exitCode/stdout/logPath，日志含 argv', async () => {
  const fixture = makeFixture();
  try {
    const built = buildWith(fixture, {}, () => ({ stdout: 'LLVM version 23.1.4\n' }));
    const result = await built.tools.mlir_run.execute({ tool: 'opt', args: ['--version'] }, fakeExec(fixture.dir));
    assert.equal(result.ok, true, String(result.hint));
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert.match(result.stdout, /23\.1\.4/);
    assert.ok(typeof result.logPath === 'string' && existsSync(result.logPath));
    assert.match(readFileSync(result.logPath, 'utf8'), /--version/);
    assert.equal(logFiles(fixture.dir).length, 1);
  } finally {
    fixture.cleanup();
  }
});

test('工具缺失：probe 返回 missing:[mlir-opt] + 中文 hint，不抛异常', async () => {
  const fixture = makeFixture();
  try {
    const built = buildWith(fixture, { mlirOptPath: join(fixture.dir, 'definitely-not-here', 'mlir-opt.exe') });
    const result = await built.tools.mlir_probe.execute({}, fakeExec(fixture.dir));
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, ['mlir-opt']);
    assert.match(String(result.hint), /缺少工具/);
  } finally {
    fixture.cleanup();
  }
});

test('mlir_run 缺工具：ok:false + missing + 中文 hint，早退字段完整', async () => {
  const fixture = makeFixture();
  try {
    const built = buildWith(fixture, { mlirOptPath: join(fixture.dir, 'definitely-not-here', 'mlir-opt.exe') });
    const result = await built.tools.mlir_run.execute({ tool: 'mlir-opt', args: ['--version'] }, fakeExec(fixture.dir));
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, ['mlir-opt']);
    assert.match(String(result.hint), /缺少工具：mlir-opt/);
    // 早退也要有完整字段，模型不用判 undefined。
    assert.equal(result.exitCode, null);
    assert.equal(result.timedOut, false);
    assert.equal(result.durationMs, 0);
    assert.equal(result.truncated, false);
    assert.equal(result.logPath, null);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  } finally {
    fixture.cleanup();
  }
});

test('mlir_run 未知工具与未知 kind：返回中文提示而非异常', async () => {
  const fixture = makeFixture();
  try {
    const built = buildWith(fixture);
    const badTool = await built.tools.mlir_run.execute({ tool: 'gcc-nope', args: [] }, fakeExec(fixture.dir));
    assert.equal(badTool.ok, false);
    assert.match(String(badTool.hint), /未知工具/);
    const badKind = await built.tools.mlir_tblgen.execute({ kind: 'nope', inputPath: 'x.td' }, fakeExec(fixture.dir));
    assert.equal(badKind.ok, false);
    assert.match(String(badKind.hint), /未知 kind/);
    assert.match(String(badKind.hint), /gen:/);
  } finally {
    fixture.cleanup();
  }
});

test('mlir_run 输出被裁剪时 hint 指向 logPath', async () => {
  const fixture = makeFixture();
  try {
    const built = buildWith(fixture, {}, () => ({ stdout: 'x'.repeat(9000) }));
    const result = await built.tools.mlir_run.execute({ tool: 'opt', args: ['--version'], maxOutputBytes: 4096 }, fakeExec(fixture.dir));
    assert.equal(result.ok, true);
    assert.equal(result.truncated, true);
    assert.match(String(result.hint), /截断/);
  } finally {
    fixture.cleanup();
  }
});

test('日志裁剪：logKeep=3 时只保留最近 3 份', async () => {
  const fixture = makeFixture();
  try {
    const built = buildWith(fixture, { logKeep: 3 });
    for (let index = 0; index < 6; index += 1) {
      await built.tools.mlir_run.execute({ tool: 'opt', args: ['--version'] }, fakeExec(fixture.dir));
    }
    assert.equal(logFiles(fixture.dir).length, 3);
  } finally {
    fixture.cleanup();
  }
});

test('mlir_tblgen：参数拼装、-o 落盘、行数字节数回报', async () => {
  const fixture = makeFixture();
  try {
    const tdPath = join(fixture.dir, 'TestOps.td');
    writeFileSync(tdPath, 'include "mlir/IR/OpBase.td"\ndef TestDialect : Dialect { let name = "testdialect"; }\n', 'utf8');
    const incPath = join(fixture.dir, 'TestOps.h.inc');
    const generated = 'class TestOp : public ::mlir::Op<TestOp> {\npublic:\n  using Op::Op;\n};\n';
    const built = buildWith(fixture, {}, (argv) => {
      const index = argv.indexOf('-o');
      if (index >= 0 && argv[index + 1] !== '-') writeFileSync(argv[index + 1], generated, 'utf8');
      return { stdout: '' };
    });
    const result = await built.tools.mlir_tblgen.execute(
      { kind: 'op-decls', inputPath: tdPath, includeDirs: [join(fixture.dir, 'mlir-include')], outputPath: incPath },
      fakeExec(fixture.dir),
    );
    assert.equal(result.ok, true, String(result.hint));
    assert.equal(result.bytes, Buffer.byteLength(generated));
    assert.ok(result.generatedLines >= 3);
    assert.equal(result.includeSource, 'args');
    const argv = built.calls[0].argv;
    assert.ok(argv.includes('-gen-op-decls'));
    assert.ok(argv.includes('-I'));
    assert.deepEqual(argv.slice(-2), ['-o', incPath]);
    assert.match(readFileSync(incPath, 'utf8'), /class TestOp/);
  } finally {
    fixture.cleanup();
  }
});

test('mlir_tblgen：自动发现 mlir/IR/OpBase.td（同级 llvm-src 源码树）', async () => {
  const fixture = makeFixture({ withSourceTree: true });
  try {
    const tdPath = join(fixture.dir, 'TestOps.td');
    writeFileSync(tdPath, 'include "mlir/IR/OpBase.td"\n', 'utf8');
    const outPath = join(fixture.dir, 'out.h.inc');
    const built = buildWith(fixture, {}, (argv) => {
      const index = argv.indexOf('-o');
      if (index >= 0 && argv[index + 1] !== '-') writeFileSync(argv[index + 1], '// generated\n', 'utf8');
      return { stdout: '' };
    });
    const result = await built.tools.mlir_tblgen.execute({ kind: 'gen:op-decls', inputPath: tdPath, outputPath: outPath }, fakeExec(fixture.dir));
    assert.equal(result.ok, true, String(result.hint));
    assert.equal(result.includeSource, 'auto');
    assert.ok(result.includeDirs.includes(fixture.sourceInclude));
    assert.ok(built.calls[0].argv.includes(fixture.sourceInclude));
  } finally {
    fixture.cleanup();
  }
});

test('mlir_tblgen：缺 OpBase.td 时 hint 列出搜索目录', async () => {
  const fixture = makeFixture();
  try {
    const tdPath = join(fixture.dir, 'TestOps.td');
    writeFileSync(tdPath, 'include "mlir/IR/OpBase.td"\n', 'utf8');
    const built = buildWith(fixture, {}, () => ({
      exitCode: 1,
      stderr: tdPath + ':1:1: error: could not find include file mlir/IR/OpBase.td\n',
    }));
    const result = await built.tools.mlir_tblgen.execute({ kind: 'op-decls', inputPath: tdPath }, fakeExec(fixture.dir));
    assert.equal(result.ok, false);
    assert.match(String(result.hint), /OpBase\.td/);
    assert.match(String(result.hint), /已搜索/);
  } finally {
    fixture.cleanup();
  }
});

test('mlir_tblgen：outputPath 父目录不存在时自动创建', async () => {
  const fixture = makeFixture();
  try {
    const tdPath = join(fixture.dir, 'TestOps.td');
    writeFileSync(tdPath, 'include "mlir/IR/OpBase.td"\n', 'utf8');
    const outPath = join(fixture.dir, 'deep', 'nested', 'out.h.inc');
    const built = buildWith(fixture, {}, (argv) => {
      const index = argv.indexOf('-o');
      if (index >= 0) writeFileSync(argv[index + 1], '// generated\n', 'utf8');
      return { stdout: '' };
    });
    const result = await built.tools.mlir_tblgen.execute({ kind: 'op-decls', inputPath: tdPath, outputPath: outPath }, fakeExec(fixture.dir));
    assert.equal(result.ok, true, String(result.hint));
    assert.ok(existsSync(outPath));
    assert.ok(existsSync(join(fixture.dir, 'deep', 'nested')));
  } finally {
    fixture.cleanup();
  }
});

test('mlir_parse_check：合法源码 ok:true、零错误', async () => {
  const fixture = makeFixture();
  try {
    const built = buildWith(fixture, {}, () => ({ stdout: 'module {\n  func.func @add(%a: i32, %b: i32) -> i32 { return %a : i32 }\n}\n' }));
    const result = await built.tools.mlir_parse_check.execute(
      { source: 'module {\n  func.func @add(%a: i32, %b: i32) -> i32 { return %a : i32 }\n}\n' },
      fakeExec(fixture.dir),
    );
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.equal(result.errors.length, 0);
    assert.deepEqual(result.notes, []);
  } finally {
    fixture.cleanup();
  }
});

test('mlir_parse_check：坏语法返回结构化 error，临时路径统一显示 <source>', async () => {
  const fixture = makeFixture();
  try {
    const built = buildWith(fixture, {}, (argv) => ({
      exitCode: 1,
      stderr: argv[1] + ':3:10: error: use of undeclared value \'%x\'\nin.mlir:4:2: note: see current operation\n',
    }));
    const result = await built.tools.mlir_parse_check.execute({ source: 'module {}\n' }, fakeExec(fixture.dir));
    assert.equal(result.ok, false);
    assert.ok(result.errors.length >= 1);
    assert.equal(result.errors[0].file, '<source>');
    assert.equal(result.errors[0].line, 3);
    assert.equal(result.errors[0].col, 10);
    assert.match(result.errors[0].message, /undeclared value/);
    assert.equal(result.notes.length, 1);
    assert.equal(result.notes[0].message, 'see current operation');
    assert.ok(typeof result.logPath === 'string' && existsSync(result.logPath));
  } finally {
    fixture.cleanup();
  }
});

test('mlir_parse_check：passes 数组包成 builtin.module(...)，字符串原样使用', async () => {
  const fixture = makeFixture();
  try {
    const built = buildWith(fixture, {}, () => ({ stdout: 'module {}\n' }));
    const arrayResult = await built.tools.mlir_parse_check.execute({ source: 'module {}\n', passes: ['cse', 'canonicalize', '-symbol-dce'] }, fakeExec(fixture.dir));
    assert.equal(arrayResult.ok, true);
    assert.equal(arrayResult.passPipeline, 'builtin.module(cse,canonicalize,symbol-dce)');
    assert.ok(built.calls[0].argv.includes('--pass-pipeline=builtin.module(cse,canonicalize,symbol-dce)'));
    const stringResult = await built.tools.mlir_parse_check.execute({ source: 'module {}\n', passes: 'builtin.module(cse)' }, fakeExec(fixture.dir));
    assert.equal(stringResult.passPipeline, 'builtin.module(cse)');
  } finally {
    fixture.cleanup();
  }
});

test('mlir_parse_check：source 与 path 同给报错且不 spawn', async () => {
  const fixture = makeFixture();
  try {
    const built = buildWith(fixture);
    const result = await built.tools.mlir_parse_check.execute({ source: 'module {}\n', path: 'x.mlir' }, fakeExec(fixture.dir));
    assert.equal(result.ok, false);
    assert.match(String(result.hint), /只能给一个/);
    assert.equal(built.calls.length, 0);
    assert.equal(result.timedOut, false);
    assert.deepEqual(result.errors, []);
  } finally {
    fixture.cleanup();
  }
});

test('mlir_parse_check：maxDiagnostics 限制返回条数', async () => {
  const fixture = makeFixture();
  try {
    const lines = [];
    for (let line = 1; line <= 8; line += 1) lines.push('in.mlir:' + String(line) + ':1: error: bad ' + String(line));
    const built = buildWith(fixture, {}, () => ({ exitCode: 1, stderr: lines.join('\n') }));
    const result = await built.tools.mlir_parse_check.execute({ source: 'module {}\n', maxDiagnostics: 2 }, fakeExec(fixture.dir));
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 2);
  } finally {
    fixture.cleanup();
  }
});

test('mlir_run 超时：ok:false、exitCode:null、timedOut:true', async () => {
  const fixture = makeFixture();
  try {
    const cfg = resolveConfig({ toolchainPath: fixture.toolchainPath }, fixture.dir);
    const run = createSubprocessRunner(fakeSpawn(() => 'hang'), 1000, 5000);
    const map = makeMap(buildMlirTools(cfg, run));
    const result = await map.mlir_run.execute({ tool: 'opt', args: ['--version'], timeoutMs: 100 }, fakeExec(fixture.dir));
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, null);
    assert.equal(result.timedOut, true);
    assert.match(String(result.hint), /超时/);
  } finally {
    fixture.cleanup();
  }
});

test('mlir_run：inputText 写临时文件并追加为最后一个参数，结束后清理', async () => {
  const fixture = makeFixture();
  try {
    const built = buildWith(fixture, {}, () => ({ stdout: 'module {}\n' }));
    const result = await built.tools.mlir_run.execute({ tool: 'mlir-opt', args: ['--mlir-print-op-generic'], inputText: 'module {}\n' }, fakeExec(fixture.dir));
    assert.equal(result.ok, true, String(result.hint));
    const argv = built.calls[0].argv;
    const appended = argv[argv.length - 1];
    assert.match(appended, /input\.mlir$/);
    assert.equal(existsSync(appended), false, '临时文件应已删除');
  } finally {
    fixture.cleanup();
  }
});

test('插件入口：apply 注册 4 个工具，dispose 时全部注销', () => {
  const fixture = makeFixture();
  try {
    const registered = [];
    const removed = [];
    const handlers = new Map();
    const ctx = {
      subprocess: { spawn: () => { throw new Error('本用例不执行子进程'); } },
      tools: { register: (definition) => { registered.push(definition); return () => { removed.push(definition.name); }; } },
      on: (event, handler) => { handlers.set(event, handler); },
    };
    apply(ctx, { toolchainPath: fixture.toolchainPath });
    assert.deepEqual(registered.map((definition) => definition.name), ['mlir_probe', 'mlir_run', 'mlir_tblgen', 'mlir_parse_check']);
    for (const definition of registered) {
      assert.equal(definition.parameters.type, 'object');
      assert.equal(typeof definition.execute, 'function');
    }
    handlers.get('dispose')();
    assert.deepEqual(removed, ['mlir_probe', 'mlir_run', 'mlir_tblgen', 'mlir_parse_check']);
  } finally {
    fixture.cleanup();
  }
});

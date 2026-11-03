import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EXE = process.platform === 'win32' ? '.exe' : '';

/** toolchain.json 里的键名（与 lib/toolchain.js 的映射保持一致）。 */
const TOOL_KEY = {
  'mlir-opt': 'mlirOpt',
  'mlir-translate': 'mlirTranslate',
  'mlir-tblgen': 'mlirTblgen',
  'mlir-runner': 'mlirRunner',
  'mlir-reduce': 'mlirReduce',
  llc: 'llc',
  opt: 'opt',
  clang: 'clang',
  filecheck: 'filecheck',
  'llvm-config': 'llvmConfig',
  'llvm-objdump': 'llvmObjdump',
};

const DEFAULT_TOOLS = ['mlir-opt', 'mlir-translate', 'mlir-tblgen', 'llc'];

/**
 * 造一个完全自包含的假工具链目录：
 *   <dir>/bin/<tool>.exe        空文件，探针只用 existsSync
 *   <dir>/llvm/.../include      假的 LLVM 安装树
 *   <dir>/llvm-build            mlirRoot
 *   <dir>/llvm-src/.../mlir/include/mlir/IR/OpBase.td   可选源码树
 *   <dir>/toolchain.json
 * 日志也会落在 <dir>/.mlir-logs，不污染工作区。
 */
export function makeFixture(options = {}) {
  const tools = options.tools ?? DEFAULT_TOOLS;
  const declared = options.versions ?? {};
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mlir-fixture-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const paths = {};
  const toolEntries = {};
  for (const name of tools) {
    const path = join(bin, name + EXE);
    writeFileSync(path, '', 'utf8');
    paths[name] = path;
    const key = TOOL_KEY[name] ?? name;
    toolEntries[key] = { path, ok: true, version: declared[name] ?? '23.1.4' };
  }
  const llvmRoot = join(dir, 'llvm', 'clang+llvm-23.1.4-x86_64-pc-windows-msvc');
  mkdirSync(join(llvmRoot, 'include'), { recursive: true });
  const mlirRoot = join(dir, 'llvm-build');
  mkdirSync(mlirRoot, { recursive: true });
  let sourceInclude = null;
  if (options.withSourceTree === true) {
    sourceInclude = join(dir, 'llvm-src', 'llvm-project-23.1.4.src', 'mlir', 'include');
    mkdirSync(join(sourceInclude, 'mlir', 'IR'), { recursive: true });
    writeFileSync(join(sourceInclude, 'mlir', 'IR', 'OpBase.td'), 'class Dialect;\n', 'utf8');
  }
  const json = {
    ok: true,
    llvm: { version: '23.1.4', root: llvmRoot, mlirRoot, tools: toolEntries },
    mlirDev: { include: join(mlirRoot, 'tools', 'mlir', 'include', 'mlir') },
  };
  const toolchainPath = join(dir, 'toolchain.json');
  writeFileSync(toolchainPath, JSON.stringify(json, null, 2), 'utf8');
  return {
    dir,
    bin,
    paths,
    llvmRoot,
    mlirRoot,
    sourceInclude,
    toolchainPath,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** 假 runner：记录 argv/cwd，按 responder 返回 {exitCode,stdout,stderr}。 */
export function fakeRunner(responder) {
  const calls = [];
  const runner = async (argv, options) => {
    calls.push({ argv, options });
    const outcome = typeof responder === 'function' ? responder(argv, options) : responder;
    return {
      exitCode: outcome?.exitCode ?? 0,
      stdout: outcome?.stdout ?? '',
      stderr: outcome?.stderr ?? '',
      timedOut: outcome?.timedOut === true,
      durationMs: 1,
      truncated: outcome?.truncated === true,
    };
  };
  runner.calls = calls;
  return runner;
}

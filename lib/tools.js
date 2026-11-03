import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { isErrorDiagnostic, parseDiagnostics } from './diag.js';
import { OPTIONAL_TOOLS, REQUIRED_TOOLS, resolveTools } from './toolchain.js';

/** 模型侧工具别名 → 真实可执行文件名。 */
const TOOL_ALIASES = {
  'mlir-opt': 'mlir-opt',
  opt: 'mlir-opt',
  'mlir-translate': 'mlir-translate',
  translate: 'mlir-translate',
  'mlir-tblgen': 'mlir-tblgen',
  tblgen: 'mlir-tblgen',
  'mlir-runner': 'mlir-runner',
  runner: 'mlir-runner',
  'mlir-reduce': 'mlir-reduce',
  reduce: 'mlir-reduce',
  llc: 'llc',
  clang: 'clang',
  filecheck: 'filecheck',
  'llvm-config': 'llvm-config',
  'llvm-objdump': 'llvm-objdump',
  objdump: 'llvm-objdump',
};

/** TableGen -gen-* 组合；键是模型用的语义名，未列出的用 gen:<名字> 或 -gen-<名字> 透传。 */
const TBLGEN_KINDS = {
  'op-decls': '-gen-op-decls',
  'op-defs': '-gen-op-defs',
  'op-doc': '-gen-op-doc',
  'op-interface-decls': '-gen-op-interface-decls',
  'op-interface-defs': '-gen-op-interface-defs',
  'op-interface-docs': '-gen-op-interface-docs',
  'dialect-decls': '-gen-dialect-decls',
  'dialect-defs': '-gen-dialect-defs',
  'dialect-doc': '-gen-dialect-doc',
  'dialect-interface-decls': '-gen-dialect-interface-decls',
  'typedef-decls': '-gen-typedef-decls',
  'typedef-defs': '-gen-typedef-defs',
  'typedef-doc': '-gen-typedef-doc',
  'attrdef-decls': '-gen-attrdef-decls',
  'attrdef-defs': '-gen-attrdef-defs',
  'attrdef-doc': '-gen-attrdef-doc',
  'enum-decls': '-gen-enum-decls',
  'enum-defs': '-gen-enum-defs',
  'enum-doc': '-gen-enum-doc',
  'attr-constraint-decls': '-gen-attr-constraint-decls',
  'attr-constraint-defs': '-gen-attr-constraint-defs',
  'type-constraint-decls': '-gen-type-constraint-decls',
  'type-constraint-defs': '-gen-type-constraint-defs',
  rewriters: '-gen-rewriters',
  'pass-decls': '-gen-pass-decls',
  'pass-doc': '-gen-pass-doc',
  'pass-capi-header': '-gen-pass-capi-header',
  'pass-capi-impl': '-gen-pass-capi-impl',
  bytecode: '-gen-bytecode',
  'directive-decl': '-gen-directive-decl',
  'llvmir-conversions': '-gen-llvmir-conversions',
  'enum-from-llvmir-conversions': '-gen-enum-from-llvmir-conversions',
  'enum-to-llvmir-conversions': '-gen-enum-to-llvmir-conversions',
  'op-from-llvmir-conversions': '-gen-op-from-llvmir-conversions',
  'convertible-llvmir-intrinsics': '-gen-convertible-llvmir-intrinsics',
  'python-op-bindings': '-gen-python-op-bindings',
  'python-enum-bindings': '-gen-python-enum-bindings',
};

/** 判断一个候选根目录能不能满足 TableGen 的 mlir/IR/OpBase.td include。 */
const OPBASE_RELATIVE = ['mlir', 'IR', 'OpBase.td'];

const VERSION_RE = /\bversion\s+([0-9][0-9A-Za-z.+-]*)/i;
const objectSchema = { type: 'object', additionalProperties: true };

function executionCwd(exec) {
  return exec !== null && exec !== undefined && exec.agent !== null && exec.agent !== undefined &&
    exec.agent.session !== null && exec.agent.session !== undefined &&
    exec.agent.session.header !== null && exec.agent.session.header !== undefined &&
    typeof exec.agent.session.header.cwd === 'string'
    ? exec.agent.session.header.cwd
    : process.cwd();
}

function firstLine(text) {
  const line = String(text === null || text === undefined ? '' : text).split(/\r?\n/).find((value) => value.trim() !== '');
  return line === undefined ? null : line.trim();
}

function clip(text, maxBytes) {
  const value = typeof text === 'string' ? text : '';
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return { text: value, clipped: false };
  if (maxBytes <= 3) return { text: value.slice(0, maxBytes), clipped: true };
  let out = value;
  let guard = 0;
  while (Buffer.byteLength(out, 'utf8') > maxBytes - 3 && guard < 64) {
    out = out.slice(0, Math.max(0, out.length - Math.max(64, Math.ceil(out.length * 0.1))));
    guard += 1;
  }
  return { text: out + '...', clipped: true };
}

function countLines(text) {
  if (typeof text !== 'string' || text === '') return 0;
  return text.split(/\r?\n/).length;
}

/** 缺工具时统一的中文指引；绝不抛 ENOENT。 */
function missingHint(missing) {
  const list = missing.join('、');
  return '缺少工具：' + list + '。插件按「显式路径覆盖 > toolchainPath 指向的 toolchain.json」查找，未使用 PATH 搜索。' +
    '修复：①跑 bash mlir-lang/gen-toolchain.sh 重新生成 toolchain.json；' +
    '②或在 profile 的 cordis.patch.yml 给 mlir-toolchain 显式补 mlirOptPath / mlirTranslatePath / mlirTblgenPath / llcPath；' +
    '③确认工具链已按 E-01 构建完成（' + list + ' 位于 D:\\Code\\llvm-build\\bin 或 LLVM 预编译目录）。';
}

function logsDir(cwd) {
  const dir = join(cwd, '.mlir-logs');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 只保留最近 keep 个 .log，避免长会话把工作区堆满。 */
function pruneLogs(dir, keep) {
  try {
    const files = readdirSync(dir)
      .filter((name) => name.endsWith('.log'))
      .map((name) => {
        const path = join(dir, name);
        let mtime = 0;
        try { mtime = statSync(path).mtimeMs; } catch { mtime = 0; }
        return { name, mtime };
      })
      .sort((left, right) => left.mtime - right.mtime);
    const excess = files.length - keep;
    if (excess <= 0) return;
    for (const file of files.slice(0, excess)) {
      try { unlinkSync(join(dir, file.name)); } catch { /* 被占用或已删除都不影响本次调用 */ }
    }
  } catch { /* 目录不可读时静默跳过 */ }
}

/** 把完整 argv/输出落盘；工作目录不可写时返回 null，不影响调用结果。 */
function writeLog(cwd, exe, argv, result, keep) {
  try {
    const dir = logsDir(cwd);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const name = exe + '-' + stamp + '-' + Math.random().toString(36).slice(2, 8) + '.log';
    const path = join(dir, name);
    const header = [
      'argv: ' + JSON.stringify(argv),
      'cwd: ' + cwd,
      'exitCode: ' + String(result.exitCode),
      'timedOut: ' + String(result.timedOut),
      'durationMs: ' + String(result.durationMs),
      '',
      '--- stdout ---',
      result.stdout,
      '',
      '--- stderr ---',
      result.stderr,
      '',
    ].join('\n');
    writeFileSync(path, header, 'utf8');
    if (Number.isFinite(keep) && keep > 0) pruneLogs(dir, keep);
    return path;
  } catch {
    return null;
  }
}

function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** mlir_run 的统一返回骨架：早退分支也补齐字段，模型不用判 undefined。 */
function runResult(overrides) {
  return {
    ok: false,
    exitCode: null,
    timedOut: false,
    durationMs: 0,
    stdout: '',
    stderr: '',
    truncated: false,
    logPath: null,
    missing: [],
    hint: null,
    ...overrides,
  };
}

/** parse_check 的统一返回骨架。 */
function parseResult(overrides) {
  return {
    ok: false,
    exitCode: null,
    timedOut: false,
    errors: [],
    warnings: [],
    notes: [],
    passPipeline: null,
    logPath: null,
    hint: null,
    ...overrides,
  };
}

/** tblgen 的统一返回骨架。 */
function tblgenResult(overrides) {
  return {
    ok: false,
    exitCode: null,
    timedOut: false,
    outputPath: null,
    generatedLines: 0,
    bytes: 0,
    stdout: '',
    stderr: '',
    truncated: false,
    includeDirs: [],
    includeSource: 'none',
    logPath: null,
    missing: [],
    hint: null,
    ...overrides,
  };
}

function safeReaddir(path) {
  try {
    return readdirSync(path).sort().slice(0, 20);
  } catch {
    return [];
  }
}

/** 该目录能否作为 -I 根（下面有 mlir/IR/OpBase.td）。 */
function hasOpBase(dir) {
  try {
    return statSync(join(dir, ...OPBASE_RELATIVE)).isFile();
  } catch {
    return false;
  }
}

/**
 * 与 LLVM 安装/构建树同级的源码树候选：<父目录>/llvm-src/<任意>/mlir/include。
 * 生成 toolchain.json 时一般只记录 llvmRoot/mlirRoot，源码树靠这条规则兜底。
 */
function sourceTreeRoots(base, add) {
  if (typeof base !== 'string' || base.trim() === '') return;
  const parents = [dirname(base), dirname(dirname(base))];
  for (const parent of parents) {
    const srcRoot = join(parent, 'llvm-src');
    for (const entry of safeReaddir(srcRoot)) {
      add(join(srcRoot, entry, 'mlir', 'include'));
    }
  }
}

/** 从 toolchain.json 推导可能的 mlir/include 根，按可靠度排序。 */
function includeCandidateRoots(resolved) {
  const roots = [];
  const add = (path) => {
    if (typeof path !== 'string' || path.trim() === '') return;
    const abs = resolve(path);
    if (!roots.includes(abs)) roots.push(abs);
  };
  const dev = resolved.mlirDev !== null && typeof resolved.mlirDev === 'object' ? resolved.mlirDev : {};
  for (const key of ['include', 'lib', 'cmakeDir', 'llvmCmakeDir']) {
    const value = dev[key];
    if (typeof value !== 'string') continue;
    add(value);
    add(dirname(value));
    add(dirname(dirname(value)));
  }
  if (typeof resolved.llvmRoot === 'string') add(join(resolved.llvmRoot, 'include'));
  if (typeof resolved.mlirRoot === 'string') {
    add(join(resolved.mlirRoot, 'include'));
    add(join(resolved.mlirRoot, 'tools', 'mlir', 'include'));
  }
  sourceTreeRoots(resolved.llvmRoot, add);
  sourceTreeRoots(resolved.mlirRoot, add);
  return roots;
}

/**
 * 决定 TableGen 的 -I：显式 includeDirs / MLIR_INCLUDE_DIR 优先，
 * 其余候选按 OpBase.td 是否存在自动挑选。
 */
function resolveIncludes(config, cwd, resolved) {
  const dirs = [];
  const auto = [];
  const searched = [];
  const push = (dir) => {
    const abs = resolve(cwd, dir);
    if (!dirs.includes(abs)) dirs.push(abs);
  };
  for (const dir of Array.isArray(config.includeDirs) ? config.includeDirs : []) {
    if (typeof dir === 'string' && dir.trim() !== '') push(dir.trim());
  }
  const env = typeof process.env.MLIR_INCLUDE_DIR === 'string' ? process.env.MLIR_INCLUDE_DIR : '';
  for (const dir of env.split(delimiter)) {
    if (dir.trim() !== '') push(dir.trim());
  }
  const explicit = dirs.length;
  const satisfied = dirs.some(hasOpBase);
  if (!satisfied) {
    for (const candidate of includeCandidateRoots(resolved)) {
      if (dirs.includes(candidate)) continue;
      searched.push(candidate);
      if (hasOpBase(candidate)) {
        auto.push(candidate);
        push(candidate);
      }
    }
  }
  const source = explicit > 0 ? 'config' : (auto.length > 0 ? 'auto' : 'none');
  return { dirs, auto, searched, source };
}

/** 把 kind 解析成 -gen-* 参数；支持语义名、gen:名字、-gen-名字 三种写法。 */
function tblgenFlag(kind) {
  if (typeof kind !== 'string') return null;
  const key = kind.trim();
  if (key === '') return null;
  if (Object.hasOwn(TBLGEN_KINDS, key)) return TBLGEN_KINDS[key];
  if (key.startsWith('-gen-')) return key;
  if (key.startsWith('gen:')) {
    const rest = key.slice(4).trim();
    if (rest === '') return null;
    return rest.startsWith('-') ? rest : '-gen-' + rest;
  }
  return null;
}

/** passes 既接受完整 pipeline 字符串，也接受 pass 名数组（自动包成 builtin.module(...)）。 */
function passPipeline(value) {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (!Array.isArray(value)) return null;
  const names = value
    .map((item) => String(item).trim())
    .filter((item) => item !== '')
    .map((item) => (item.startsWith('-') ? item.slice(1) : item));
  if (names.length === 0) return null;
  const joined = names.join(',');
  return /^[A-Za-z_][A-Za-z0-9_]*\(/.test(joined) ? joined : 'builtin.module(' + joined + ')';
}

/** TableGen include 报错识别：不同版本措辞略有差异，用宽一点的匹配。 */
function looksLikeIncludeError(text) {
  return /could not find include file|include file not found|could not find file/i.test(text) ||
    /OpBase\.td/.test(text);
}

function includeHint(searched, cwd) {
  const sample = searched.length > 0 ? searched.slice(0, 8).join('、') : '（未找到候选目录）';
  return 'TableGen 找不到 include（多半是 mlir/IR/OpBase.td）。已搜索：' + sample + '。' +
    '修复：①给本工具传 includeDirs；②或设环境变量 MLIR_INCLUDE_DIR；' +
    '③或把 MLIR 源码放在 <LLVM 安装/构建目录的父目录>/llvm-src/*/mlir/include。' +
    '典型值：<llvm-project>/mlir/include，命令行即 -I <llvm-project>/mlir/include。';
}

/** 构建 4 个工具定义：probe / run / tblgen / parse_check。 */
export function buildMlirTools(config, runner) {
  const probe = {
    name: 'mlir_probe',
    description: '探测 MLIR 工具链：读 toolchain.json（或显式路径），并行对 mlir-opt / mlir-translate / mlir-tblgen / llc 等跑 --version，返回 ok、版本、每个工具路径、缺失/失败清单、版本不一致项，以及 mlir_tblgen 会自动使用的 include 目录。缺工具返回 ok:false + 中文 hint，不抛异常。任何 MLIR 任务前先跑一次。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: objectSchema,
      render: (_args, value) => {
        const rec = value !== null && typeof value === 'object' ? value : {};
        const llvm = rec.llvm !== null && typeof rec.llvm === 'object' ? rec.llvm : {};
        const tools = rec.tools !== null && typeof rec.tools === 'object' ? rec.tools : {};
        const lines = ['MLIR 工具链（source=' + String(rec.source) + '）：' + (rec.ok === true ? '可用' : '不可用')];
        if (typeof llvm.version === 'string') lines.push('- LLVM/MLIR 版本：' + llvm.version);
        if (typeof llvm.root === 'string') lines.push('- LLVM 根：' + llvm.root);
        for (const [name, entry] of Object.entries(tools)) {
          const item = entry !== null && typeof entry === 'object' ? entry : {};
          const status = item.exists !== true
            ? '缺失'
            : (item.ok === true ? 'ok ' + String(item.version === null || item.version === undefined ? '' : item.version) : '存在但 --version 失败');
          lines.push('- ' + name + '：' + status + (typeof item.path === 'string' ? '（' + item.path + '）' : ''));
        }
        if (Array.isArray(rec.missing) && rec.missing.length > 0) lines.push('- 缺失（必需）：' + rec.missing.join('、'));
        if (Array.isArray(rec.failed) && rec.failed.length > 0) lines.push('- 执行失败（必需）：' + rec.failed.join('、'));
        if (Array.isArray(rec.optionalMissing) && rec.optionalMissing.length > 0) lines.push('- 缺失（可选）：' + rec.optionalMissing.join('、'));
        if (Array.isArray(rec.versionMismatch) && rec.versionMismatch.length > 0) {
          lines.push('- 版本与 toolchain.json 不一致：' + rec.versionMismatch.map((item) => String(item.name) + ' 声明 ' + String(item.declared) + ' / 实际 ' + String(item.actual)).join('；'));
        }
        const include = rec.tblgenInclude !== null && typeof rec.tblgenInclude === 'object' ? rec.tblgenInclude : null;
        if (include !== null && Array.isArray(include.dirs) && include.dirs.length > 0) {
          lines.push('- TableGen include（' + String(include.source) + '）：' + include.dirs.join('、'));
        }
        if (typeof rec.hint === 'string' && rec.hint !== '') lines.push('- 建议：' + rec.hint);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(_rawArgs, exec) {
      const cwd = executionCwd(exec);
      const resolved = resolveTools(config, cwd);
      const names = [...new Set([...REQUIRED_TOOLS, ...OPTIONAL_TOOLS, ...Object.keys(resolved.paths)])];
      const timeoutMs = Math.min(config.timeoutMs, 20000);
      // 并行探测：工具多时比逐个 spawn 快一个数量级。
      const entries = await Promise.all(names.map(async (name) => {
        const path = typeof resolved.paths[name] === 'string' ? resolved.paths[name] : null;
        const required = REQUIRED_TOOLS.includes(name);
        const declared = resolved.versions[name] ?? null;
        if (path === null || !existsSync(path)) {
          return { name, required, entry: { path, exists: false, ok: false, version: declared, firstLine: null, required } };
        }
        let ok = false;
        let version = declared;
        let first = null;
        let error = null;
        try {
          const result = await runner([path, '--version'], { cwd, timeoutMs });
          ok = result.exitCode === 0 && !result.timedOut;
          const text = result.stdout + result.stderr;
          first = firstLine(text);
          const match = VERSION_RE.exec(text);
          if (match !== null) version = match[1];
          if (!ok) error = result.timedOut ? '--version 超时' : 'exitCode ' + String(result.exitCode);
        } catch (thrown) {
          ok = false;
          error = thrown !== null && typeof thrown === 'object' && typeof thrown.message === 'string' ? thrown.message : String(thrown);
        }
        return { name, required, declared, actual: version, entry: { path, exists: true, ok, version, firstLine: first, required, error } };
      }));

      const tools = {};
      const missing = [];
      const failed = [];
      const optionalMissing = [];
      const optionalFailed = [];
      const versionMismatch = [];
      for (const { name, required, declared, actual, entry } of entries) {
        tools[name] = entry;
        if (entry.exists !== true) {
          if (required) missing.push(name);
          else optionalMissing.push(name);
          continue;
        }
        if (entry.ok !== true) {
          if (required) failed.push(name);
          else optionalFailed.push(name);
          continue;
        }
        if (typeof declared === 'string' && typeof actual === 'string' && declared !== actual) {
          versionMismatch.push({ name, declared, actual });
        }
      }
      const ok = missing.length === 0 && failed.length === 0;
      let hint = null;
      if (!ok) {
        hint = resolved.source === 'none'
          ? '没找到 toolchain.json（' + String(resolved.notes[0] ?? '未配置 toolchainPath') + '），也没有显式工具路径。先生成 toolchain.json：bash mlir-lang/gen-toolchain.sh。'
          : missingHint([...missing, ...failed]);
      } else if (optionalMissing.length > 0) {
        hint = '必需工具齐全；可选工具缺失：' + optionalMissing.join('、') + '（只影响用到它们的调用）。';
      }
      const includes = resolveIncludes(config, cwd, resolved);
      return {
        ok,
        source: resolved.source,
        toolchainPath: resolved.toolchainPath,
        llvm: { version: resolved.version, root: resolved.llvmRoot, mlirRoot: resolved.mlirRoot },
        tools,
        missing,
        failed,
        optionalMissing,
        optionalFailed,
        versionMismatch,
        tblgenInclude: { source: includes.source, dirs: includes.dirs },
        notes: resolved.notes,
        hint,
      };
    },
    timeoutMs: Math.min(config.timeoutMs, 60000),
  };

  const run = {
    name: 'mlir_run',
    description: '用 argv 方式运行 MLIR/LLVM 工具（mlir-opt / mlir-translate / mlir-tblgen / mlir-runner / mlir-reduce / llc / clang / filecheck / llvm-config / llvm-objdump）。返回 exitCode、stdout、stderr、durationMs、truncated、logPath；工具缺失返回 ok:false + missing + 中文 hint，超时返回 exitCode:null、timedOut:true。inputText 会写成临时 .mlir 并作为最后一个参数，inputPath 按会话 cwd 解析后追加。',
    parameters: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: '工具名或别名：mlir-opt/opt、mlir-translate/translate、mlir-tblgen/tblgen、mlir-runner/runner、mlir-reduce/reduce、llc、clang、filecheck、llvm-config/llvm-objdump。' },
        args: { type: 'array', items: { type: 'string' }, description: '传给工具的原始参数数组（不经过 shell）。' },
        inputText: { type: 'string', description: '可选：MLIR 源码文本；写临时文件并追加为最后一个参数。' },
        inputPath: { type: 'string', description: '可选：输入文件路径，按会话 cwd 解析后追加为最后一个参数。' },
        cwd: { type: 'string', description: '可选：子进程工作目录，按会话 cwd 解析；默认会话 cwd。' },
        timeoutMs: { type: 'number', description: '可选：本次超时（毫秒），上限取插件配置的 timeoutMs。' },
        maxOutputBytes: { type: 'number', description: '可选：stdout/stderr 各自返回上限（字节），默认取插件配置。' },
      },
      required: ['tool'],
      additionalProperties: false,
    },
    output: {
      schema: objectSchema,
      render: (_args, value) => {
        const rec = value !== null && typeof value === 'object' ? value : {};
        const lines = ['mlir_run：' + (rec.ok === true ? '成功' : '失败') + '（exitCode=' + String(rec.exitCode) + (rec.timedOut === true ? '，超时' : '') + '，' + String(rec.durationMs) + 'ms）'];
        if (Array.isArray(rec.missing) && rec.missing.length > 0) lines.push('- 缺失工具：' + rec.missing.join('、'));
        if (typeof rec.stdout === 'string' && rec.stdout !== '') lines.push('- stdout：\n' + rec.stdout.trimEnd());
        if (typeof rec.stderr === 'string' && rec.stderr !== '') lines.push('- stderr：\n' + rec.stderr.trimEnd());
        if (typeof rec.logPath === 'string') lines.push('- 完整日志：' + rec.logPath);
        if (typeof rec.hint === 'string' && rec.hint !== '') lines.push('- 建议：' + rec.hint);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(rawArgs, exec) {
      const cwd = executionCwd(exec);
      const input = rawArgs !== null && typeof rawArgs === 'object' ? rawArgs : {};
      const resolved = resolveTools(config, cwd);
      const rawTool = typeof input.tool === 'string' ? input.tool.trim() : '';
      const exe = TOOL_ALIASES[rawTool];
      if (exe === undefined) {
        return runResult({ hint: '未知工具 ' + JSON.stringify(rawTool) + '；可用：' + Object.keys(TOOL_ALIASES).join('、') });
      }
      const path = typeof resolved.paths[exe] === 'string' ? resolved.paths[exe] : null;
      if (path === null || !existsSync(path)) {
        return runResult({ missing: [exe], hint: missingHint([exe]) });
      }
      const argv = [path];
      if (Array.isArray(input.args)) {
        for (const arg of input.args) argv.push(String(arg));
      }
      const temps = [];
      try {
        if (typeof input.inputText === 'string' && input.inputText.length > 0) {
          const dir = makeTempDir('dsh-mlir-');
          temps.push(dir);
          const inputPath = join(dir, 'input.mlir');
          writeFileSync(inputPath, input.inputText, 'utf8');
          argv.push(inputPath);
        } else if (typeof input.inputPath === 'string' && input.inputPath.trim() !== '') {
          const inputPath = resolve(cwd, input.inputPath.trim());
          if (!existsSync(inputPath)) {
            return runResult({ hint: '输入文件不存在：' + inputPath });
          }
          argv.push(inputPath);
        }
        const workdir = typeof input.cwd === 'string' && input.cwd.trim() !== '' ? resolve(cwd, input.cwd.trim()) : cwd;
        const timeoutMs = Math.min(
          typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0 ? Math.trunc(input.timeoutMs) : config.timeoutMs,
          config.timeoutMs,
        );
        const maxBytes = typeof input.maxOutputBytes === 'number' && Number.isFinite(input.maxOutputBytes) && input.maxOutputBytes > 0
          ? Math.min(Math.trunc(input.maxOutputBytes), 8 * 1024 * 1024)
          : config.maxOutputBytes;
        let result;
        try {
          result = await runner(argv, { cwd: workdir, timeoutMs, signal: exec !== null && exec !== undefined ? exec.signal : undefined });
        } catch (error) {
          const message = error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : String(error);
          return runResult({ hint: '启动 ' + exe + ' 失败：' + message });
        }
        const stdoutClip = clip(result.stdout, maxBytes);
        const stderrClip = clip(result.stderr, maxBytes);
        const logPath = writeLog(workdir, exe, argv, result, config.logKeep);
        const ok = result.exitCode === 0 && !result.timedOut;
        const truncated = result.truncated === true || stdoutClip.clipped || stderrClip.clipped;
        let hint = null;
        if (result.timedOut) hint = '超时（' + timeoutMs + 'ms）已终止进程；完整输出见 logPath。可调大 timeoutMs 或给插件配置更大的上限。';
        else if (!ok) hint = exe + ' 退出码 ' + String(result.exitCode) + '；stderr 见上，完整日志在 logPath。';
        else if (truncated) hint = '输出被截断（上限 ' + maxBytes + ' 字节/路）；完整内容见 logPath，需要更多时调大 maxOutputBytes。';
        return runResult({
          ok,
          exitCode: result.exitCode,
          timedOut: result.timedOut === true,
          durationMs: result.durationMs,
          stdout: stdoutClip.text,
          stderr: stderrClip.text,
          truncated,
          logPath,
          hint,
        });
      } finally {
        for (const dir of temps) {
          try { rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录清理失败不影响结果 */ }
        }
      }
    },
    timeoutMs: config.timeoutMs + 10000,
  };

  const tblgen = {
    name: 'mlir_tblgen',
    description: '运行 mlir-tblgen 生成代码：kind 取 op-decls / op-defs / dialect-decls / dialect-defs / typedef-decls / typedef-defs / attrdef-* / enum-* / pass-decls / rewriters 等，也接受 gen:<名字> 或 -gen-<名字> 透传。inputPath 是 .td 文件；includeDirs 展开成 -I，未给时自动找 mlir/IR/OpBase.td（toolchain.json 的 mlirDev、LLVM include、同级 llvm-src 源码树）；outputPath 给出则写文件（父目录自动创建）并回报行数字节数，不给则 -o - 输出到 stdout。',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: '生成目标（语义名或原始 -gen-*）：op-decls | op-defs | dialect-decls | dialect-defs | typedef-decls | typedef-defs | attrdef-decls | enum-decls | pass-decls | rewriters | gen:<名字> | -gen-<名字>。' },
        inputPath: { type: 'string', description: '.td 文件路径（按会话 cwd 解析）。' },
        includeDirs: { type: 'array', items: { type: 'string' }, description: '可选：-I 目录数组；不给时自动探测含 mlir/IR/OpBase.td 的目录。' },
        outputPath: { type: 'string', description: '可选：输出文件路径（父目录会自动创建）；不给则返回 stdout。' },
        extraArgs: { type: 'array', items: { type: 'string' }, description: '可选：追加给 mlir-tblgen 的额外参数。' },
      },
      required: ['kind', 'inputPath'],
      additionalProperties: false,
    },
    output: {
      schema: objectSchema,
      render: (_args, value) => {
        const rec = value !== null && typeof value === 'object' ? value : {};
        const lines = ['mlir_tblgen：' + (rec.ok === true ? '成功' : '失败') + '（exitCode=' + String(rec.exitCode) + '）'];
        if (typeof rec.outputPath === 'string') lines.push('- 输出：' + rec.outputPath + '（' + String(rec.generatedLines) + ' 行，' + String(rec.bytes) + ' 字节）');
        else if (typeof rec.stdout === 'string' && rec.stdout !== '') lines.push('- stdout（' + String(rec.generatedLines) + ' 行）：\n' + rec.stdout.slice(0, 4000));
        if (Array.isArray(rec.includeDirs) && rec.includeDirs.length > 0) lines.push('- include（' + String(rec.includeSource) + '）：' + rec.includeDirs.join('、'));
        if (typeof rec.stderr === 'string' && rec.stderr !== '') lines.push('- stderr：\n' + rec.stderr.trimEnd());
        if (typeof rec.hint === 'string' && rec.hint !== '') lines.push('- 建议：' + rec.hint);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(rawArgs, exec) {
      const cwd = executionCwd(exec);
      const input = rawArgs !== null && typeof rawArgs === 'object' ? rawArgs : {};
      const resolved = resolveTools(config, cwd);
      const exe = 'mlir-tblgen';
      const path = typeof resolved.paths[exe] === 'string' ? resolved.paths[exe] : null;
      if (path === null || !existsSync(path)) {
        return tblgenResult({ missing: [exe], hint: missingHint([exe]) });
      }
      const kindKey = typeof input.kind === 'string' ? input.kind.trim() : '';
      const flag = tblgenFlag(kindKey);
      if (flag === null) {
        return tblgenResult({ hint: '未知 kind ' + JSON.stringify(kindKey) + '；可用：' + Object.keys(TBLGEN_KINDS).join('、') + '，或直接写 gen:<名字> / -gen-<名字>。' });
      }
      const inputPath = typeof input.inputPath === 'string' ? resolve(cwd, input.inputPath.trim()) : '';
      if (inputPath === '' || !existsSync(inputPath)) {
        return tblgenResult({ hint: 'inputPath 不存在：' + inputPath });
      }
      const includes = resolveIncludes(config, cwd, resolved);
      const explicitlyGiven = Array.isArray(input.includeDirs) && input.includeDirs.some((dir) => typeof dir === 'string' && dir.trim() !== '');
      const includeDirs = [];
      if (explicitlyGiven) {
        for (const dir of input.includeDirs) {
          if (typeof dir === 'string' && dir.trim() !== '') {
            const abs = resolve(cwd, dir.trim());
            if (!includeDirs.includes(abs)) includeDirs.push(abs);
          }
        }
      }
      for (const dir of includes.dirs) {
        if (!includeDirs.includes(dir)) includeDirs.push(dir);
      }
      const includeSource = explicitlyGiven ? 'args' : includes.source;
      const argv = [path];
      for (const dir of includeDirs) argv.push('-I', dir);
      const outputPath = typeof input.outputPath === 'string' && input.outputPath.trim() !== '' ? resolve(cwd, input.outputPath.trim()) : null;
      argv.push(flag, inputPath);
      if (outputPath === null) argv.push('-o', '-');
      else argv.push('-o', outputPath);
      if (Array.isArray(input.extraArgs)) {
        for (const arg of input.extraArgs) argv.push(String(arg));
      }
      let result;
      try {
        if (outputPath !== null) {
          try { mkdirSync(dirname(outputPath), { recursive: true }); } catch {
            return tblgenResult({ outputPath, includeDirs, includeSource, hint: '创建输出目录失败：' + dirname(outputPath) });
          }
        }
        result = await runner(argv, { cwd, timeoutMs: config.timeoutMs, signal: exec !== null && exec !== undefined ? exec.signal : undefined });
      } catch (error) {
        const message = error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : String(error);
        return tblgenResult({ outputPath, includeDirs, includeSource, hint: '启动 mlir-tblgen 失败：' + message });
      }
      const logPath = writeLog(cwd, exe, argv, result, config.logKeep);
      let generatedLines = 0;
      let bytes = 0;
      let stdout = '';
      if (outputPath !== null) {
        if (existsSync(outputPath)) {
          try {
            const stat = statSync(outputPath);
            bytes = stat.size;
            generatedLines = countLines(readFileSync(outputPath, 'utf8'));
          } catch { bytes = 0; }
        }
      } else {
        stdout = result.stdout;
        generatedLines = countLines(stdout);
        bytes = Buffer.byteLength(stdout, 'utf8');
      }
      const hasOutput = outputPath !== null ? bytes > 0 : stdout.trim() !== '';
      const ok = result.exitCode === 0 && !result.timedOut && hasOutput;
      const diagnosticText = result.stdout + '\n' + result.stderr;
      let hint = null;
      if (result.timedOut) hint = '超时（' + config.timeoutMs + 'ms）已终止 mlir-tblgen。';
      else if (looksLikeIncludeError(diagnosticText) && result.exitCode !== 0) hint = includeHint([...includes.searched, ...includeDirs], cwd);
      else if (result.exitCode !== 0) hint = 'mlir-tblgen 退出码 ' + String(result.exitCode) + '；常见原因：.td 里引用的 def 不存在、kind 与 def 类型不匹配。完整日志：' + String(logPath);
      else if (!hasOutput) hint = 'mlir-tblgen 退出码 0 但没生成内容；确认 flag 与 def 类型匹配（如 rewriters 需要 Pattern）。';
      return tblgenResult({
        ok,
        exitCode: result.exitCode,
        timedOut: result.timedOut === true,
        outputPath,
        generatedLines,
        bytes,
        stdout: stdout.slice(0, 20000),
        stderr: result.stderr,
        truncated: result.truncated === true,
        includeDirs,
        includeSource,
        logPath,
        hint,
      });
    },
    timeoutMs: config.timeoutMs + 10000,
  };

  const parseCheck = {
    name: 'mlir_parse_check',
    description: '用 mlir-opt 校验 MLIR：source 或 path 二选一（同时给报错）。可选 passes 先跑指定 pass（--pass-pipeline，数组自动包成 builtin.module(...)），比单纯 parse 更容易暴露 IR 不合法。返回结构化的 errors / warnings / notes（file、line、col、severity、message）、exitCode 与完整 logPath；坏语法时 ok:false 但仍正常返回，不抛异常。',
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'MLIR 源码文本（与 path 二选一）。' },
        path: { type: 'string', description: '.mlir 文件路径（与 source 二选一，按会话 cwd 解析）。' },
        passes: {
          anyOf: [
            { type: 'string', description: '完整 pass pipeline，如 builtin.module(cse,canonicalize)。' },
            { type: 'array', items: { type: 'string' }, description: 'pass 名数组，如 ["cse","canonicalize"]，自动包成 builtin.module(...)。' },
          ],
          description: '可选：先跑这些 pass 再校验。',
        },
        maxDiagnostics: { type: 'number', description: '可选：最多返回多少条 error（默认 200，上限 1000）；warnings/notes 最多 50 条。' },
        allowDiagnostics: { type: 'boolean', description: '可选：true 时即使有诊断也返回 ok:true（诊断仍照常列出），用于预期会告警的测试。' },
      },
      additionalProperties: false,
    },
    output: {
      schema: objectSchema,
      render: (_args, value) => {
        const rec = value !== null && typeof value === 'object' ? value : {};
        const errors = Array.isArray(rec.errors) ? rec.errors : [];
        const warnings = Array.isArray(rec.warnings) ? rec.warnings : [];
        const notes = Array.isArray(rec.notes) ? rec.notes : [];
        const lines = ['mlir_parse_check：' + (rec.ok === true ? '通过' : '失败') + '（exitCode=' + String(rec.exitCode) + '，' + String(errors.length) + ' 个错误 / ' + String(warnings.length) + ' 个告警）'];
        for (const item of errors.slice(0, 20)) {
          lines.push('- error ' + (typeof item.file === 'string' ? item.file + ':' : '') + String(item.line ?? '?') + ':' + String(item.col ?? '?') + ' ' + String(item.message));
        }
        for (const item of warnings.slice(0, 10)) {
          lines.push('- warning ' + (typeof item.file === 'string' ? item.file + ':' : '') + String(item.line ?? '?') + ':' + String(item.col ?? '?') + ' ' + String(item.message));
        }
        for (const item of notes.slice(0, 5)) {
          lines.push('- note ' + String(item.message));
        }
        if (typeof rec.passPipeline === 'string') lines.push('- pass pipeline：' + rec.passPipeline);
        if (typeof rec.logPath === 'string') lines.push('- 完整日志：' + rec.logPath);
        if (typeof rec.hint === 'string' && rec.hint !== '') lines.push('- 建议：' + rec.hint);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(rawArgs, exec) {
      const cwd = executionCwd(exec);
      const input = rawArgs !== null && typeof rawArgs === 'object' ? rawArgs : {};
      const resolved = resolveTools(config, cwd);
      const exe = 'mlir-opt';
      const path = typeof resolved.paths[exe] === 'string' ? resolved.paths[exe] : null;
      if (path === null || !existsSync(path)) {
        return parseResult({ hint: missingHint([exe]) });
      }
      const hasSource = typeof input.source === 'string' && input.source.trim() !== '';
      const hasPath = typeof input.path === 'string' && input.path.trim() !== '';
      if (hasSource && hasPath) {
        return parseResult({ hint: 'source 与 path 只能给一个：内联源码用 source，已有文件用 path。' });
      }
      const maxDiagnostics = typeof input.maxDiagnostics === 'number' && Number.isFinite(input.maxDiagnostics)
        ? Math.min(1000, Math.max(1, Math.trunc(input.maxDiagnostics)))
        : 200;
      const pipeline = passPipeline(input.passes);
      const passArg = pipeline === null ? null : '--pass-pipeline=' + pipeline;
      const temps = [];
      try {
        let sourcePath = null;
        if (hasSource) {
          const dir = makeTempDir('dsh-mlir-parse-');
          temps.push(dir);
          sourcePath = join(dir, 'input.mlir');
          writeFileSync(sourcePath, input.source, 'utf8');
        } else if (hasPath) {
          sourcePath = resolve(cwd, input.path.trim());
          if (!existsSync(sourcePath)) {
            return parseResult({ hint: '文件不存在：' + sourcePath });
          }
        } else {
          return parseResult({ hint: 'source 与 path 至少给一个。' });
        }
        const outDir = makeTempDir('dsh-mlir-parse-out-');
        temps.push(outDir);
        const outPath = join(outDir, 'out.mlir');
        const argv = [path, sourcePath];
        if (passArg !== null) argv.push(passArg);
        argv.push('-o', outPath);
        let result;
        try {
          result = await runner(argv, { cwd, timeoutMs: config.timeoutMs, signal: exec !== null && exec !== undefined ? exec.signal : undefined });
        } catch (error) {
          const message = error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : String(error);
          return parseResult({ passPipeline: pipeline, hint: '启动 mlir-opt 失败：' + message });
        }
        const diagnostics = parseDiagnostics(result.stdout + '\n' + result.stderr);
        const relabel = (item) => (hasSource && item.file === sourcePath ? { ...item, file: '<source>' } : item);
        const errors = diagnostics.filter(isErrorDiagnostic).map(relabel).slice(0, maxDiagnostics);
        const warnings = diagnostics.filter((item) => item.severity === 'warning').map(relabel).slice(0, 50);
        const notes = diagnostics.filter((item) => item.severity === 'note').map(relabel).slice(0, 50);
        const logPath = writeLog(cwd, 'mlir-opt-parse', argv, result, config.logKeep);
        const ok = input.allowDiagnostics === true ? true : result.exitCode === 0 && errors.length === 0;
        let hint = null;
        if (result.timedOut) hint = '超时（' + config.timeoutMs + 'ms）已终止 mlir-opt。';
        else if (!ok && pipeline !== null && /no such pass|unknown pass|unregistered pass/i.test(result.stdout + result.stderr)) {
          hint = 'pass pipeline 里有未知 pass：' + pipeline + '。跑 mlir-opt --help 看可用 pass，或先不带 passes 只做解析。';
        } else if (!ok && errors.length > 0) hint = '解析失败，先按第一个 error 的 file:line:col 改源码。';
        else if (!ok) hint = 'mlir-opt 退出码 ' + String(result.exitCode) + ' 但没解析出诊断；打开 logPath 看原始输出。';
        return parseResult({ ok, exitCode: result.exitCode, timedOut: result.timedOut === true, errors, warnings, notes, passPipeline: pipeline, logPath, hint });
      } finally {
        for (const dir of temps) {
          try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响结果 */ }
        }
      }
    },
    timeoutMs: Math.min(config.timeoutMs, 60000),
  };

  return [probe, run, tblgen, parseCheck];
}

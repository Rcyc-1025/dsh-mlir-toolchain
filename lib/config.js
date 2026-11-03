import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 插件包根目录（安装成 node_modules 链接时 ESM 默认解析到真实路径）。 */
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** 插件默认配置：60s 足够 mlir-opt 处理中等模块，长编译由调用方显式放大。 */
const DEFAULTS = {
  toolchainPath: null,
  toolOverrides: {},
  includeDirs: [],
  timeoutMs: 120000,
  maxOutputBytes: 1048576,
  graceMs: 5000,
  logKeep: 100,
};

/** 单工具路径覆盖键 → 可执行文件名。 */
const OVERRIDE_KEYS = {
  mlirOptPath: 'mlir-opt',
  mlirTranslatePath: 'mlir-translate',
  mlirTblgenPath: 'mlir-tblgen',
  mlirRunnerPath: 'mlir-runner',
  mlirReducePath: 'mlir-reduce',
  llcPath: 'llc',
  clangPath: 'clang',
  optPath: 'opt',
  filecheckPath: 'filecheck',
  llvmObjdumpPath: 'llvm-objdump',
  llvmConfigPath: 'llvm-config',
};

/**
 * 解析插件配置：显式路径覆盖 > toolchainPath，数值夹到安全区间。
 * @param raw - cordis.patch.yml 里传进来的 config。
 * @param cwd - 会话工作目录，用于解析相对路径。
 */
export function resolveConfig(raw, cwd) {
  const input = raw !== null && typeof raw === 'object' ? raw : {};
  const config = { ...DEFAULTS, ...input, toolOverrides: { ...(input.toolOverrides || {}) } };
  for (const [key, tool] of Object.entries(OVERRIDE_KEYS)) {
    const value = input[key];
    if (typeof value === 'string' && value.trim() !== '') config.toolOverrides[tool] = value.trim();
  }
  const explicit = typeof input.toolchainPath === 'string' && input.toolchainPath.trim() !== ''
    ? input.toolchainPath.trim()
    : (typeof process.env.MLIR_TOOLCHAIN_JSON === 'string' && process.env.MLIR_TOOLCHAIN_JSON.trim() !== ''
      ? process.env.MLIR_TOOLCHAIN_JSON.trim()
      : null);
  config.toolchainPath = explicit === null
    ? discoverToolchain(cwd)
    : resolve(cwd, explicit);
  config.includeDirs = normalizeDirs(input.includeDirs);
  config.timeoutMs = clampInt(config.timeoutMs, 1000, 600000, DEFAULTS.timeoutMs);
  config.maxOutputBytes = clampInt(config.maxOutputBytes, 4096, 8 * 1024 * 1024, DEFAULTS.maxOutputBytes);
  config.graceMs = clampInt(config.graceMs, 500, 30000, DEFAULTS.graceMs);
  config.logKeep = clampInt(config.logKeep, 1, 5000, DEFAULTS.logKeep);
  return config;
}

/**
 * 未显式配置时按固定顺序找 toolchain.json：插件包同级（mlir-lang/toolchain.json）、
 * 包内、会话 cwd、cwd/mlir-lang。装上即可用，无需改 profile 的 cordis.patch.yml。
 */
export function discoverToolchain(cwd) {
  const candidates = [
    join(PACKAGE_ROOT, '..', 'toolchain.json'),
    join(PACKAGE_ROOT, 'toolchain.json'),
    resolve(cwd, 'toolchain.json'),
    resolve(cwd, 'mlir-lang', 'toolchain.json'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** includeDirs 既接受数组也接受单个字符串；去空去重，保留原始写法（相对路径在执行期按 cwd 解析）。 */
function normalizeDirs(value) {
  const list = Array.isArray(value) ? value : (typeof value === 'string' ? [value] : []);
  const out = [];
  for (const item of list) {
    if (typeof item !== 'string' || item.trim() === '') continue;
    const dir = item.trim();
    if (!out.includes(dir)) out.push(dir);
  }
  return out;
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

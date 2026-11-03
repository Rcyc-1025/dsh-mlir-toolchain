import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { discoverToolchain } from './config.js';

/** 必须能跑的工具：缺任何一个 probe 判 ok:false。 */
export const REQUIRED_TOOLS = ['mlir-opt', 'mlir-translate', 'mlir-tblgen', 'llc'];

/** 可选工具：缺了只提示，不影响 probe 结论。 */
export const OPTIONAL_TOOLS = ['mlir-runner', 'mlir-reduce', 'opt', 'clang', 'filecheck', 'cmake', 'ninja'];

/** toolchain.json 里的键名 → 可执行文件名。 */
const TOOLCHAIN_TO_EXE = {
  mlirOpt: 'mlir-opt',
  mlirTranslate: 'mlir-translate',
  mlirTblgen: 'mlir-tblgen',
  mlirRunner: 'mlir-runner',
  mlirReduce: 'mlir-reduce',
  llc: 'llc',
  opt: 'opt',
  clang: 'clang',
  llvmConfig: 'llvm-config',
  llvmObjdump: 'llvm-objdump',
  cmake: 'cmake',
  ninja: 'ninja',
  filecheck: 'filecheck',
};

/**
 * 读 toolchain.json；永不抛错（坏文件也返回 error 字符串）。
 * @param path - toolchain.json 绝对路径或 null。
 */
export function loadToolchainFile(path) {
  if (typeof path !== 'string' || path.trim() === '') return { json: null, error: '未配置 toolchainPath' };
  if (!existsSync(path)) return { json: null, error: 'toolchain.json 不存在：' + path };
  try {
    return { json: JSON.parse(readFileSync(path, 'utf8')), error: null };
  } catch (error) {
    const message = error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : String(error);
    return { json: null, error: 'toolchain.json 解析失败：' + message };
  }
}

/**
 * 解析出「工具名 → 可执行文件绝对路径」。来源优先级：显式覆盖 > toolchain.json。
 * @param config - resolveConfig 的结果。
 * @param cwd - 解析相对覆盖路径用。
 */
export function resolveTools(config, cwd) {
  const overrides = config.toolOverrides || {};
  // 插件在宿主启动时解析配置，那时 cwd 未必是会话语义目录；这里再按会话 cwd 兜底发现一次。
  const toolchainPath = typeof config.toolchainPath === 'string' && config.toolchainPath !== ''
    ? config.toolchainPath
    : discoverToolchain(cwd);
  const loaded = loadToolchainFile(toolchainPath);
  const json = loaded.json;
  const paths = {};
  const versions = {};
  const notes = [];
  let source = 'none';
  let llvmRoot = null;
  let mlirRoot = null;
  let mlirDev = null;
  let version = null;

  if (json !== null && typeof json.llvm === 'object' && json.llvm !== null) {
    source = 'toolchain.json';
    llvmRoot = typeof json.llvm.root === 'string' ? json.llvm.root : null;
    mlirRoot = typeof json.llvm.mlirRoot === 'string' ? json.llvm.mlirRoot : null;
    version = typeof json.llvm.version === 'string' ? json.llvm.version : null;
    const tools = json.llvm.tools !== null && typeof json.llvm.tools === 'object' ? json.llvm.tools : {};
    for (const [key, exe] of Object.entries(TOOLCHAIN_TO_EXE)) {
      const entry = tools[key];
      if (entry !== null && typeof entry === 'object' && typeof entry.path === 'string') {
        paths[exe] = entry.path;
        if (typeof entry.version === 'string') versions[exe] = entry.version;
      }
    }
    if (json.cmake !== null && typeof json.cmake === 'object' && typeof json.cmake.path === 'string') {
      paths.cmake = json.cmake.path;
      if (typeof json.cmake.version === 'string') versions.cmake = json.cmake.version;
    }
    if (json.ninja !== null && typeof json.ninja === 'object' && typeof json.ninja.path === 'string') {
      paths.ninja = json.ninja.path;
      if (typeof json.ninja.version === 'string') versions.ninja = json.ninja.version;
    }
    if (json.mlirDev !== null && typeof json.mlirDev === 'object') {
      mlirDev = pickStrings(json.mlirDev, ['include', 'lib', 'cmakeDir', 'llvmCmakeDir']);
    }
  } else if (typeof loaded.error === 'string') {
    notes.push(loaded.error);
  }

  let overrode = false;
  for (const [exe, rawPath] of Object.entries(overrides)) {
    if (typeof rawPath !== 'string' || rawPath.trim() === '') continue;
    paths[exe] = resolve(cwd, rawPath.trim());
    overrode = true;
  }
  if (overrode && source === 'none') source = 'config';

  return { source, llvmRoot, mlirRoot, mlirDev, version, paths, versions, notes, toolchainPath };
}

/** 只挑出字符串字段，避免把 undefined 塞进结果。 */
function pickStrings(object, keys) {
  const out = {};
  for (const key of keys) {
    if (typeof object[key] === 'string' && object[key].trim() !== '') out[key] = object[key];
  }
  return out;
}

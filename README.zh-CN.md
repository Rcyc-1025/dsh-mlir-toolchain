# dsh-mlir-toolchain

**DeepSeek Harness（DSH）的 MLIR 工具链插件** —— 探测、运行、TableGen 生成、语法校验，全走 argv，不碰 shell，也不会把 `ENOENT` 抛给模型。

[English](README.md) | 简体中文

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%5E22.19.0%20%7C%7C%20%3E%3D24.0.0-brightgreen)

它把构建脚本产出的 `toolchain.json` 变成四个面向模型的工具，底层由宿主的 subprocess 服务执行：

| 工具 | 作用 |
| --- | --- |
| `mlir_probe` | 读 `toolchain.json`，**并行**对每个工具跑 `--version`，报告 `ok`、缺失 vs. 执行失败、版本不一致，以及 TableGen 会使用的 include 目录 |
| `mlir_run` | 用 argv 数组运行 `mlir-opt`、`mlir-translate`、`mlir-tblgen`、`mlir-runner`、`mlir-reduce`、`llc`、`clang`、`filecheck`、`llvm-config`、`llvm-objdump` |
| `mlir_tblgen` | `-gen-*` 代码生成：35 个语义 kind、`gen:<名字>` 透传、自动发现 `mlir/IR/OpBase.td`、输出目录自动创建 |
| `mlir_parse_check` | 用 `mlir-opt` 校验 MLIR，可选先跑 pass pipeline，返回结构化 errors/warnings/notes |

所有命令都是 argv 数组，不经过 shell、不依赖 `PATH`，插件本身 **零运行时依赖**。

## 环境要求

- Node.js `^22.19.0 || >=24.0.0`
- DeepSeek Harness `>=0.2.1-rc.5 <0.3.0-0`
- LLVM/MLIR 可执行文件。开发和验收使用 LLVM 23.1.4；其他较新版本只要提供 `mlir-opt`、`mlir-translate`、`mlir-tblgen`、`llc` 即可。
- `mlir-tblgen` 还需要 MLIR 的 TableGen 头（`mlir/IR/OpBase.td`），来自源码树或安装好的 `mlir/include`。

推荐提供 `toolchain.json`（多余字段会被忽略）：

```json
{
  "llvm": {
    "version": "23.1.4",
    "root": "/opt/llvm",
    "mlirRoot": "/opt/llvm-build",
    "tools": {
      "mlirOpt":       { "path": "/opt/llvm-build/bin/mlir-opt",       "version": "23.1.4" },
      "mlirTranslate": { "path": "/opt/llvm-build/bin/mlir-translate", "version": "23.1.4" },
      "mlirTblgen":    { "path": "/opt/llvm-build/bin/mlir-tblgen",    "version": "23.1.4" },
      "llc":           { "path": "/opt/llvm/bin/llc",                  "version": "23.1.4" },
      "mlirRunner":    { "path": "/opt/llvm-build/bin/mlir-runner" },
      "llvmConfig":    { "path": "/opt/llvm/bin/llvm-config" }
    }
  },
  "mlirDev": {
    "include": "/opt/llvm-project/mlir/include",
    "lib": "/opt/llvm-build/lib"
  }
}
```

可识别的 `llvm.tools` 键：`mlirOpt`、`mlirTranslate`、`mlirTblgen`、`mlirRunner`、`mlirReduce`、`llc`、`opt`、`clang`、`llvmConfig`、`llvmObjdump`、`cmake`、`ninja`、`filecheck`。

## 安装

```bash
# 在本仓库所在目录执行
dsh plugin --profile desktop add ./dsh-mlir-toolchain
```

CLI 会把包加入 profile 的 `dsh.profile.bundles`；插件通过自带的 `cordis.patch.yml` 自注册。服务端插件热重载，四个工具会立即出现。卸载：

```bash
dsh plugin --profile desktop remove dsh-mlir-toolchain
```

> 在 DSH `workspace-write` 沙箱会话里安装时，profile 目录可能在 workspace 之外；请在普通终端安装，或按提示授予权限。

## 配置

当 `toolchain.json` 位于插件目录旁边（常见的 `mlir-lang/dsh-mlir-toolchain` + `mlir-lang/toolchain.json` 布局）、插件目录内、会话 cwd 或 `<cwd>/mlir-lang/` 时，零配置即可用。插件加载时找一次；如果当时没找到，每次工具执行时还会按**会话 cwd** 再找一次，所以在别的目录里打开的会话也能接上。

优先级：`config.toolchainPath` / `MLIR_TOOLCHAIN_JSON` > 自动发现。

指定具体文件或覆盖单个可执行文件：

```yaml
- id: mlir-toolchain
  name: 'dsh-mlir-toolchain'
  config:
    toolchainPath: /opt/llvm/toolchain.json   # 可选
    includeDirs:                              # 可选：额外的 -I 根
      - /opt/llvm-project/mlir/include
    timeoutMs: 120000
    maxOutputBytes: 1048576
    logKeep: 100
    # 单工具覆盖（绝对路径或相对 cwd）：
    # mlirOptPath, mlirTranslatePath, mlirTblgenPath, mlirRunnerPath,
    # mlirReducePath, llcPath, optPath, clangPath, filecheckPath,
    # llvmObjdumpPath, llvmConfigPath
```

| 配置项 | 默认值 | 含义 |
| --- | --- | --- |
| `toolchainPath` | 自动 | `toolchain.json` 的绝对路径 |
| `includeDirs` | `[]` | 额外的 TableGen include 根 |
| `timeoutMs` | `120000` | 单次调用超时（夹在 1 秒–10 分钟） |
| `maxOutputBytes` | `1048576` | 每路 stdout/stderr 返回上限（夹在 4 KiB–8 MiB） |
| `graceMs` | `5000` | 超时后强制杀进程前的宽限时间 |
| `logKeep` | `100` | `.mlir-logs/` 只保留最近 N 份 |

环境变量：`MLIR_TOOLCHAIN_JSON`（`toolchain.json` 路径）、`MLIR_INCLUDE_DIR`（TableGen include 根，`;`/`:` 分隔）。

## 工具说明

### `mlir_probe`

并行探测配置里出现的所有工具。

```json
{ "ok": true, "source": "toolchain.json",
  "llvm": { "version": "23.1.4", "root": "/opt/llvm", "mlirRoot": "/opt/llvm-build" },
  "tools": { "mlir-opt": { "path": "...", "exists": true, "ok": true, "version": "23.1.4" } },
  "missing": [], "failed": [], "optionalMissing": ["filecheck"],
  "versionMismatch": [], "tblgenInclude": { "source": "auto", "dirs": ["..."] } }
```

`missing` 表示文件不存在；`failed` 表示文件存在但 `--version` 失败。TableGen 会用的 include 目录也会在这里回显，便于在生成代码前发现 `-I` 配错。

### `mlir_run`

```json
{ "tool": "mlir-opt", "args": ["--pass-pipeline=builtin.module(cse)"],
  "inputText": "module { ... }", "cwd": ".", "timeoutMs": 30000 }
```

返回 `{ ok, exitCode, timedOut, durationMs, stdout, stderr, truncated, logPath, hint }`。`inputText` 会写成临时 `.mlir` 并追加为最后一个参数；`inputPath` 按会话 cwd 解析。输出超过 `maxOutputBytes` 时完整内容写入 `.mlir-logs/`，`hint` 会指向该日志。

### `mlir_tblgen`

```json
{ "kind": "op-decls", "inputPath": "include/MyOps.td",
  "outputPath": "build/MyOps.h.inc" }
```

- `kind` 支持语义名（`op-decls`、`op-defs`、`op-doc`、`op-interface-decls/defs/docs`、`dialect-decls/defs/doc`、`dialect-interface-decls`、`typedef-decls/defs/doc`、`attrdef-decls/defs/doc`、`enum-decls/defs/doc`、`attr-constraint-decls/defs`、`type-constraint-decls/defs`、`rewriters`、`pass-decls`、`pass-doc`、`pass-capi-header`、`pass-capi-impl`、`bytecode`、`directive-decl`、`llvmir-conversions`、`enum-from/to-llvmir-conversions`、`op-from-llvmir-conversions`、`convertible-llvmir-intrinsics`、`python-op-bindings`、`python-enum-bindings` 等），也可以直接写 `gen:<名字>` / `-gen-<名字>`。
- `includeDirs` 可省略；省略时插件自己找 MLIR include 根。
- `outputPath` 可省略（输出到 stdout）；父目录会自动创建。
- 返回 `{ ok, exitCode, timedOut, outputPath, generatedLines, bytes, includeDirs, includeSource, logPath, hint }`。

**include 解析顺序：** 工具参数 → 插件 `includeDirs` → `MLIR_INCLUDE_DIR` → 自动候选。候选只有实际包含 `mlir/IR/OpBase.td` 才会被采用，范围包括：`mlirDev.include`/`lib`/`cmakeDir`（及其父目录）、`<llvm.root>/include`、`<mlirRoot>/include`、`<mlirRoot>/tools/mlir/include`，以及两个根目录旁或再上一层旁的 `llvm-src/*/mlir/include`。找不到时 hint 会列出搜索过的每个目录。

### `mlir_parse_check`

```json
{ "source": "module { func.func @f(%a: i32) -> i32 { return %a : i32 } }",
  "passes": ["cse", "canonicalize"], "maxDiagnostics": 200 }
```

- `source` 与 `path` 只能给一个（同时给会直接报错，不 spawn）。
- `passes` 可传完整 pipeline 字符串（`builtin.module(cse,canonicalize)`），也可传数组（自动包成 `builtin.module(...)`），走 `--pass-pipeline=`。
- 返回结构化 `errors`、`warnings`、`notes`（`file`、`line`、`col`、`severity`、`message`）、`exitCode`、`passPipeline`、`logPath`。内联源码的诊断文件名统一为 `<source>`。
- `allowDiagnostics: true` 时即使有诊断也返回 `ok: true`（适合预期会有 warning 的测试）。

## 设计约束

- 只用宿主服务 `ctx.subprocess` 与 `ctx.tools`；不 import `@deepseek-ai/dsh-*`，无运行时依赖。
- 所有命令都是 argv 数组，绝不拼 shell 字符串。
- 工作目录默认取会话 cwd，相对路径按它解析。
- `apply()` 里不做长阻塞：探测全部放在 `mlir_probe.execute`（内部并行 spawn）。
- 失败以数据返回（`ok:false` + hint），不抛异常——工具链缺失不会让宿主或插件启动失败。

## 开发

```bash
npm test        # 单元测试（自包含 fixture）+ 真实集成测试（无 toolchain.json / 无 spawn 权限时自动 skip）
npm run smoke   # 四个工具的真实端到端检查
```

- 必须用 `--test-isolation=none` 加显式文件列表：`node --test test/` 会 fork 测试子进程，而 DSH 的 `workspace-write` 沙箱禁止 fork（`spawn EPERM`）。在该环境下跑时集成本身会 skip。
- `test/fixtures.mjs` 在临时目录里造一套假工具链（`bin/*.exe` 占位文件、`llvm-src/.../OpBase.td`、`toolchain.json`），单元测试不依赖本机 LLVM，也不会往仓库里写日志。
- `test/integration.test.mjs` 与 `test/smoke.mjs` 会调用真实二进制；读取 `MLIR_TOOLCHAIN_JSON`（或同样的自动发现），没有时明确 skip/提示。

## 许可证

[MIT](LICENSE)

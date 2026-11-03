import { resolveConfig } from './config.js';
import { createSubprocessRunner } from './exec.js';
import { buildMlirTools } from './tools.js';

/**
 * dsh-mlir-toolchain —— MLIR 工具链插件（P-01）。
 *
 * 把 E-01 生成的 toolchain.json 变成 4 个面向模型的工具：
 * mlir_probe / mlir_run / mlir_tblgen / mlir_parse_check。执行走宿主 subprocess 服务
 * （argv 数组、无 shell、无 PATH 假设），零运行时依赖。配置缺失时插件照常加载，
 * 工具在 execute 里返回 ok:false + 中文 hint，不让宿主启动失败。
 *
 * @module dsh-mlir-toolchain
 */

/** cordis 服务注入：apply 里要用 ctx.subprocess 与 ctx.tools。 */
export const name = 'mlir-toolchain';
export const inject = ['subprocess', 'tools'];

/**
 * 插件入口：解析配置、封装 subprocess 执行器、注册 4 个工具。
 * @param ctx - 宿主上下文（至少含 subprocess.spawn 与 tools.register）。
 * @param config - cordis.patch.yml 里的 config（可缺省）。
 */
export function apply(ctx, config) {
  const cfg = resolveConfig(config, process.cwd());
  const runner = createSubprocessRunner((spec) => ctx.subprocess.spawn(spec), cfg.graceMs, cfg.timeoutMs);
  const disposers = [];
  for (const definition of buildMlirTools(cfg, runner)) {
    disposers.push(ctx.tools.register(definition));
  }
  if (typeof ctx.on === 'function') {
    ctx.on('dispose', () => {
      for (const dispose of disposers) dispose();
    });
  }
}

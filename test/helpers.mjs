import { spawnSync } from 'node:child_process';

/** 构造 exec 上下文：只提供会话 cwd。 */
export function fakeExec(cwd) {
  return { agent: { session: { header: { cwd } } } };
}

/**
 * 假宿主 spawn：返回 {done, collected}，按 handler 给出的结果收尾。
 * handler(spec) 返回 {exitCode, stdout, stderr}；返回字符串 'hang' 表示只有
 * spec.signal abort 才收尾（模拟超时被杀）。
 */
export function fakeSpawn(handler) {
  const calls = [];
  const spawn = (spec) => {
    calls.push(spec);
    let resolveDone;
    const done = new Promise((resolve) => { resolveDone = resolve; });
    const outcome = handler(spec);
    if (outcome === 'hang') {
      if (spec.signal !== undefined && spec.signal !== null) {
        spec.signal.addEventListener('abort', () => resolveDone({ exitCode: null, signal: 'aborted' }), { once: true });
      }
    } else {
      resolveDone({ exitCode: outcome.exitCode, signal: null });
    }
    const collected = {
      stdout: { readFrom: () => ({ text: outcome === 'hang' ? '' : (outcome.stdout ?? ''), truncated: false, lossy: false }) },
      stderr: { readFrom: () => ({ text: outcome === 'hang' ? '' : (outcome.stderr ?? ''), truncated: false, lossy: false }) },
    };
    return { done, collected };
  };
  spawn.calls = calls;
  return spawn;
}

/** 真实子进程是否可用（部分沙箱禁止 node 再 spawn，用于跳过集成测试）。 */
export function canSpawnRealProcesses() {
  try {
    const result = spawnSync(process.execPath, ['-v'], { encoding: 'utf8', windowsHide: true });
    return result.error === undefined && result.status === 0;
  } catch {
    return false;
  }
}

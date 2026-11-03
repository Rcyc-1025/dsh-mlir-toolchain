/** MLIR/LLVM 诊断行形如 D:/x.mlir:3:10: error: msg 或 error: msg（无位置）。 */
const WITH_RANGE = /^(.*?):(\d+):(\d+):\s+(fatal error|error|warning|note|remark):\s+(.*)$/i;
const WITH_LINE = /^(.*?):(\d+):\s+(fatal error|error|warning|note|remark):\s+(.*)$/i;
const NO_LOCATION = /^(fatal error|error|warning|note|remark):\s+(.*)$/i;

/**
 * 把工具输出里的诊断解析成结构化数组；源码摘录、caret 行等非诊断行直接忽略。
 * @param text - stderr 与 stdout 的拼接。
 */
export function parseDiagnostics(text) {
  const out = [];
  for (const rawLine of String(text === null || text === undefined ? '' : text).split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line === '') continue;
    let match = WITH_RANGE.exec(line);
    if (match !== null) {
      out.push({ file: match[1], line: Number(match[2]), col: Number(match[3]), severity: match[4].toLowerCase(), message: match[5].trim(), raw: line });
      continue;
    }
    match = WITH_LINE.exec(line);
    if (match !== null) {
      out.push({ file: match[1], line: Number(match[2]), col: null, severity: match[3].toLowerCase(), message: match[4].trim(), raw: line });
      continue;
    }
    match = NO_LOCATION.exec(line);
    if (match !== null) {
      out.push({ file: null, line: null, col: null, severity: match[1].toLowerCase(), message: match[2].trim(), raw: line });
    }
  }
  return out;
}

/** error / fatal error 才算失败；warning / note / remark 只提示。 */
export function isErrorDiagnostic(diagnostic) {
  return diagnostic.severity === 'error' || diagnostic.severity === 'fatal error';
}

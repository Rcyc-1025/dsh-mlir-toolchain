import assert from 'node:assert/strict';
import test from 'node:test';
import { isErrorDiagnostic, parseDiagnostics } from '../lib/diag.js';

test('解析带行/列/严重级的诊断', () => {
  const text = [
    "D:/work/a.mlir:3:10: error: 'arith.addi' op operand type mismatch",
    "D:/work/a.mlir:7:2: warning: unused value",
    'error: no previous prototype',
    '  %0 = arith.addi %1, %2 : i32',
    '         ^',
    '',
  ].join('\n');
  const list = parseDiagnostics(text);
  assert.equal(list.length, 3);
  assert.deepEqual(
    { file: list[0].file, line: list[0].line, col: list[0].col, severity: list[0].severity },
    { file: 'D:/work/a.mlir', line: 3, col: 10, severity: 'error' },
  );
  assert.match(list[0].message, /operand type mismatch/);
  assert.equal(list[1].severity, 'warning');
  assert.equal(list[2].file, null);
  assert.equal(list[2].line, null);
  assert.equal(isErrorDiagnostic(list[0]), true);
  assert.equal(isErrorDiagnostic(list[1]), false);
});

test('空输入不炸', () => {
  assert.deepEqual(parseDiagnostics(''), []);
  assert.deepEqual(parseDiagnostics(null), []);
});

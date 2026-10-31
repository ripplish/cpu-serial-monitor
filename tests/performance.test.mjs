import test from 'node:test';
import assert from 'node:assert/strict';
import { cpuPerformance } from '../dist/performance.mjs';

const cnn = {cycles:1620000,model:'a'.repeat(64)};
test('CNN performance reports measured interval and inference-only share', () => {
  const result = cpuPerformance([
    {source:'serial',received_ms:1000,cnn},
    {source:'serial',received_ms:3560,cnn},
  ]);
  assert.equal(result.phase,'CNN 整数推理');
  assert.equal(result.computeMs,60);
  assert.equal(result.intervalMs,2560);
  assert.equal(result.share,2.34375);
  assert.equal(result.intervalSource,'按相邻结果接收时间');
});

test('first CNN frame uses current sampling window and wheel uses reported analysis time', () => {
  const first=cpuPerformance([{source:'serial',received_ms:1000,cnn}]);
  assert.equal(first.intervalMs,2560);
  assert.match(first.intervalSource,/200 Hz/);
  const wheel=cpuPerformance([{source:'serial',received_ms:1000,wheel:{analysis_us:50000,fs:200,n:512}}]);
  assert.equal(wheel.phase,'FFT 与特征分析');
  assert.equal(wheel.cycles,1350000);
  assert.equal(wheel.computeMs,50);
});

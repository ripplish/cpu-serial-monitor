export const CPU_CLOCK_HZ = 27000000;
const CURRENT_CNN_FS = 200;
const CURRENT_CNN_N = 512;

function compatible(previous, latest) {
  if (!previous || previous.source !== latest.source) return false;
  if (latest.cnn) return Boolean(previous.cnn) && previous.cnn.model === latest.cnn.model;
  if (latest.wheel) return Boolean(previous.wheel);
  return false;
}

export function cpuPerformance(records) {
  const latest = records.at(-1);
  if (!latest) return null;

  let phase, cycles, computeMs, configuredIntervalMs;
  if (latest.cnn) {
    phase = 'CNN 整数推理';
    cycles = latest.cnn.cycles;
    computeMs = cycles * 1000 / CPU_CLOCK_HZ;
    configuredIntervalMs = CURRENT_CNN_N * 1000 / CURRENT_CNN_FS;
  } else if (latest.wheel && Number.isFinite(latest.wheel.analysis_us)) {
    phase = 'FFT 与特征分析';
    computeMs = latest.wheel.analysis_us / 1000;
    cycles = Math.round(computeMs * CPU_CLOCK_HZ / 1000);
    configuredIntervalMs = latest.wheel.fs > 0 && latest.wheel.n > 0 ? latest.wheel.n * 1000 / latest.wheel.fs : null;
  } else return null;

  let previous = null;
  for (let index = records.length - 2; index >= 0; index--) {
    if (compatible(records[index], latest)) { previous = records[index]; break; }
  }
  const measured = previous && latest.received_ms > previous.received_ms ? latest.received_ms - previous.received_ms : null;
  const intervalMs = measured ?? configuredIntervalMs;
  const share = intervalMs > 0 ? computeMs * 100 / intervalMs : null;
  const configuredLabel = latest.cnn
    ? '按当前 200 Hz / 512 点配置'
    : latest.wheel?.fs > 0 && latest.wheel?.n > 0
      ? `按报文 ${latest.wheel.fs} Hz / ${latest.wheel.n} 点配置`
      : '按固件窗口配置';
  return {
    phase, cycles, computeMs, intervalMs, share,
    waitMs: intervalMs > 0 ? Math.max(0, intervalMs - computeMs) : null,
    intervalSource: measured === null ? configuredLabel : '按相邻结果接收时间',
  };
}

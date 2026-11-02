export const CNN_CLASSES=['正常','重心偏移','轴承松动'];
export const CNN_FIVE_CLASSES=['正常空载','正常带载','重心偏移','带载松动','空载松动'];
export function cnnClasses(c) { return c.version>=2?CNN_FIVE_CLASSES:CNN_CLASSES; }
export function validateCnn(value) {
  const fail=()=>{throw new Error('CNN结果字段无效或截断');};
  const count=value?.version>=2?5:3;
  if(!value || ![1,2,3].includes(value.version) || !Number.isInteger(value.pred) || value.pred<0 || value.pred>=count ||
     !Array.isArray(value.scores) || value.scores.length!==count ||
     value.scores.some(v=>!Number.isInteger(v)||v< -2147483648||v>2147483647) ||
     typeof value.trained!=='boolean' || !/^[0-9a-f]{64}$/.test(value.model) || /^0+$/.test(value.model) ||
     !['experimental'].includes(value.scope)) fail();
  for(const k of ['cycles','rpm_ref','overruns'])if(!Number.isSafeInteger(value[k])||value[k]<0||(value.version<3&&value[k]>0xffffffff))fail();
  if(!value.cycles)fail();
  const prediction=value.scores.indexOf(Math.max(...value.scores));if(prediction!==value.pred)fail();
  if(value.rms_floor!==undefined && (!Number.isInteger(value.rms_floor)||value.rms_floor<0||value.rms_floor>0xffffffff))fail();
  if(value.version===2 && (value.fs!==800 || value.n!==512))fail();
  if(value.version===3 && (value.fs!==800||value.n!==1024||value.history!==1||value.architecture!=='phase-mlp784-128-64-5'||!['cpu','mac4'].includes(value.backend)||!Number.isSafeInteger(value.clock_hz)||value.clock_hz<=0||value.clock_hz>1e9))fail();
  if(value.history!==undefined && (value.version<2 || !(value.version===3?[1]:[1,3,5]).includes(value.history)))fail();
  return {...(value.version===3?{architecture:value.architecture,backend:value.backend,clock_hz:value.clock_hz}:{}),...(value.rms_floor===undefined?{}:{rms_floor:value.rms_floor}),...(value.history===undefined?{}:{history:value.history}),...(value.version>=2?{fs:value.fs,n:value.n}:{}),version:value.version,pred:value.pred,scores:[...value.scores],trained:value.trained,model:value.model,
    cycles:value.cycles,rpm_ref:value.rpm_ref,overruns:value.overruns,scope:value.scope};
}
export function cnnStatus(c,rms) {
  const knownFloor=c.model==="4174d17054269f881b1b5c5578cdd28af114f9b4b4b219ca7398dfbac80ca0cc"?166:0;
  const floor=c.rms_floor>0?c.rms_floor:knownFloor;
  if(Number.isFinite(rms) && floor>0 && rms<floor) return {label:"低振动，暂不判类",tone:"neutral",detail:`当前 ${rms} mg 低于训练覆盖下界 ${floor} mg，已暂停显示故障分类；这不是停机检测，也不表示设备正常。原始分数仅供调试。`};
  return {label:`${c.version===3?'MLP':'CNN'}预测：${cnnClasses(c)[c.pred]}`,tone:(c.version>=2?c.pred>=2:c.pred>0)?'warning':'neutral',
    detail:`${c.trained?'实采训练的探索模型':'未训练模型，仅计算测试'}；${c.history>1?`当前与过去${c.history}窗融合，覆盖约${(c.history*c.n/c.fs).toFixed(1)}秒，仍每${(c.n/c.fs).toFixed(2)}秒更新，工况切换可能滞后；`:''}分数不是概率，预测尚需独立采集验证。参考转速 ${c.rpm_ref} rpm（配置值）。`};
}

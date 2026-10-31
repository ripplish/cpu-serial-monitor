export const CNN_CLASSES=['正常','重心偏移','轴承松动'];
export function validateCnn(value) {
  const fail=()=>{throw new Error('CNN结果字段无效或截断');};
  if(!value || value.version!==1 || !Number.isInteger(value.pred) || value.pred<0 || value.pred>2 ||
     !Array.isArray(value.scores) || value.scores.length!==3 ||
     value.scores.some(v=>!Number.isInteger(v)||v< -2147483648||v>2147483647) ||
     typeof value.trained!=='boolean' || !/^[0-9a-f]{64}$/.test(value.model) || /^0+$/.test(value.model) ||
     !['experimental'].includes(value.scope)) fail();
  for(const k of ['cycles','rpm_ref','overruns'])if(!Number.isInteger(value[k])||value[k]<0||value[k]>0xffffffff)fail();
  if(!value.cycles)fail();
  const prediction=value.scores.indexOf(Math.max(...value.scores));if(prediction!==value.pred)fail();
  if(value.rms_floor!==undefined && (!Number.isInteger(value.rms_floor)||value.rms_floor<0||value.rms_floor>0xffffffff))fail();
  return {...(value.rms_floor===undefined?{}:{rms_floor:value.rms_floor}),version:1,pred:value.pred,scores:[...value.scores],trained:value.trained,model:value.model,
    cycles:value.cycles,rpm_ref:value.rpm_ref,overruns:value.overruns,scope:value.scope};
}
export function cnnStatus(c,rms) {
  const knownFloor=c.model==="4174d17054269f881b1b5c5578cdd28af114f9b4b4b219ca7398dfbac80ca0cc"?166:0;
  const floor=c.rms_floor>0?c.rms_floor:knownFloor;
  if(Number.isFinite(rms) && floor>0 && rms<floor) return {label:"低振动，暂不判类",tone:"neutral",detail:`当前 ${rms} mg 低于训练覆盖下界 ${floor} mg，已暂停显示故障分类；这不是停机检测，也不表示设备正常。原始分数仅供调试。`};
  return {label:`CNN预测：${CNN_CLASSES[c.pred]}`,tone:c.pred?'warning':'neutral',
    detail:`${c.trained?'实采训练的探索模型':'未训练模型，仅计算测试'}；分数不是概率，预测尚需独立采集验证。参考转速 ${c.rpm_ref} rpm（配置值）。`};
}

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
  return {version:1,pred:value.pred,scores:[...value.scores],trained:value.trained,model:value.model,
    cycles:value.cycles,rpm_ref:value.rpm_ref,overruns:value.overruns,scope:value.scope};
}
export function cnnStatus(c) {
  return {label:`CNN预测：${CNN_CLASSES[c.pred]}`,tone:c.pred?'warning':'neutral',
    detail:`${c.trained?'实采训练的探索模型':'未训练模型，仅计算测试'}；分数不是概率，预测尚需独立采集验证。参考转速 ${c.rpm_ref} rpm（配置值）。`};
}

import { decodeUartLog, wheelStatus, alarmLabels, wheelCsv, MAX_LOG_CHARS } from './uart.mjs?v=20261031.1';

export function mountDecoder() {
  const $=id=>document.getElementById(id);
  let result=null, example=false;
  const number=(value,scale=1,suffix='')=>value===undefined?'—':`${(value/scale).toLocaleString('zh-CN',{maximumFractionDigits:3})}${suffix}`;
  function message(text,error=false) {
    $('decode-message').textContent=text;
    $('decode-message').className='decoder-message'+(error?' decoder-error':'');
  }
  function download(content,type,name) {
    const url=URL.createObjectURL(new Blob([content],{type}));
    const anchor=document.createElement('a'); anchor.href=url; anchor.download=name;
    document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  function chart() {
    const data=(result?.windows??[]).slice(-300), svg=$('decode-trend'); svg.replaceChildren();
    const ns='http://www.w3.org/2000/svg';
    function add(tag,attributes,text) {
      const node=document.createElementNS(ns,tag);
      for(const [key,value] of Object.entries(attributes)) node.setAttribute(key,String(value));
      if(text!==undefined) node.textContent=text;
      svg.append(node);
    }
    const metric=$('decode-metric').value||'rms_mg';
    const max=Math.max(1,...data.map(row=>row[metric]));
    add('title',{},metric==='peak_mg'?'粘贴日志的振动峰值趋势，单位mg':'粘贴日志的振动有效值趋势，单位mg');
    for(let i=0;i<4;i++) {
      const y=20+i*45; add('line',{x1:44,x2:744,y1:y,y2:y,stroke:'#e6eae4','stroke-dasharray':'4 5'});
      add('text',{x:36,y:y+4,'text-anchor':'end',fill:'#7c8781','font-size':11},number(max*(3-i)/3));
    }
    if(!data.length) { add('text',{x:390,y:90,'text-anchor':'middle',fill:'#7c8781','font-size':13},'解码出窗口数据后显示趋势'); return; }
    let path='';
    data.forEach((row,index)=>{
      const x=data.length===1?394:44+index*700/(data.length-1), y=155-row[metric]/max*135;
      const move=!index||row.win!==data[index-1].win+1;
      path+=`${move?'M':'L'}${x.toFixed(2)},${y.toFixed(2)} `;
      if(move || index===data.length-1) add('circle',{cx:x,cy:y,r:2.7,fill:'#295d45'});
    });
    add('path',{d:path,fill:'none',stroke:'#295d45','stroke-width':2});
    add('text',{x:44,y:181,fill:'#7c8781','font-size':11},`窗口 ${data[0].win}`);
    add('text',{x:744,y:181,'text-anchor':'end',fill:'#7c8781','font-size':11},`窗口 ${data.at(-1).win} · mg`);
  }
  function render() {
    const rows=result?.windows??[], latest=rows.at(-1), last=result?.entries.at(-1);
    $('decode-output').value=result?.text??'';
    $('decode-count').textContent=`${number(rows.length)} 个有效窗口 · ${number(result?.byteCount??0)} 个HEX字节`;
    $('decode-copy').disabled=!result?.text; $('decode-save').disabled=!result?.text;
    $('decode-csv').disabled=!rows.length;
    $('decode-origin').textContent=example?'示例数据 · 非板上实测':'粘贴 / 文件解析 · 与实时串口会话分开';
    const state=last?.kind==='wheel'?wheelStatus(last.data):last;
    $('decode-state').textContent=state?.label??'等待日志';
    $('decode-state').className='decode-state '+(state?.tone??'neutral');
    $('decode-detail').textContent=state?.detail??(result?.text?'文本已还原，尚未识别到完整的轮轴状态行。':'粘贴串口工具里的HEX日志，或导入 .txt / .log 文件。');
    $('decode-rms').textContent=number(latest?.rms_mg,1,' mg');
    $('decode-peak').textContent=number(latest?.peak_mg,1,' mg');
    $('decode-base').textContent=latest?`${latest.base}/12`:'—';
    $('decode-overrun').textContent=number(latest?.overrun);
    $('decode-last-note').textContent=latest?`最后有效窗口 ${latest.win}；若后面出现错误，上方状态以最后一条事件为准。`:'尚无完整窗口，片段和错误不会被当成正常数据。';
    const body=$('decode-rows'); body.replaceChildren();
    if(!rows.length) {
      const row=document.createElement('tr'),cell=document.createElement('td');cell.colSpan=9;cell.className='empty-cell';
      cell.textContent='解析后显示窗口、中文状态和振动指标';row.append(cell);body.append(row);
    } else for(const data of rows.slice(-200).reverse()) {
      const row=document.createElement('tr'),status=wheelStatus(data);
      const values=[data.win,status.label,number(data.rms_mg),number(data.peak_mg),number(data.peak_mHz,1000),number(data.crest_x1000,1000),number(data.kurt_x1000,1000),`${data.base}/12`,alarmLabels(data.flags).join('、')||'未触发标志'];
      for(const value of values) { const cell=document.createElement('td');cell.textContent=String(value);row.append(cell); }
      body.append(row);
    }
    $('decode-warnings').textContent=(result?.warnings??[]).join(' ');
    chart();
  }
  function decode() {
    try {
      result=decodeUartLog($('decode-input').value,$('decode-format').value||'auto',$('decode-encoding').value||'utf-8');
      render();
      message(result.text?`已还原文本，识别 ${result.windows.length} 个窗口、${result.events.length} 条状态事件；仅在本机浏览器处理。`:'请先粘贴接收日志。');
    } catch(error) { result=null;render();message(error.message,true); }
  }
  $('decode-run').addEventListener('click',decode);
  $('decode-input').addEventListener('input',()=>{example=false;});
  $('decode-format').addEventListener('change',()=>{if($('decode-input').value) decode();});
  $('decode-encoding').addEventListener('change',()=>{if($('decode-input').value) decode();});
  $('decode-metric').addEventListener('change',chart);
  $('decode-example').addEventListener('click',()=>{
    const lines=[
      'CALIBRATION START: healthy machine, unchanged speed/load required',
      'win=1 fs=200 n=512 rpm_ref=280 rms_mg=12 peak_mg=35 crest_x1000=2916 kurt_x1000=3200 peak_mHz=4687 f1_permille=600 h23_permille=50 base=1 flags=0 status=LEARNING overrun=0 max_read_us=1173 analysis_us=73000',
      'win=12 fs=200 n=512 rpm_ref=280 rms_mg=13 peak_mg=36 crest_x1000=2769 kurt_x1000=3300 peak_mHz=4687 f1_permille=620 h23_permille=55 base=12 flags=0 status=BASELINE_READY overrun=0 max_read_us=1173 analysis_us=73000',
      'win=13 fs=200 n=512 rpm_ref=280 rms_mg=30 peak_mg=85 crest_x1000=2833 kurt_x1000=3400 peak_mHz=4687 f1_permille=650 h23_permille=60 base=12 flags=0 status=NO_THRESHOLD_EXCEEDED overrun=0 max_read_us=1173 analysis_us=73000',
      'win=14 fs=200 n=512 rpm_ref=280 rms_mg=32 peak_mg=87 crest_x1000=2718 kurt_x1000=3500 peak_mHz=4687 f1_permille=660 h23_permille=55 base=12 flags=3 status=SUSPECT overrun=0 max_read_us=1173 analysis_us=73000',
    ];
    const hex=[...new TextEncoder().encode(lines.join('\r\n')+'\r\n')].map(byte=>byte.toString(16).padStart(2,'0').toUpperCase());
    $('decode-input').value='[14:11:24.905]收←◆'+hex.join(' ');
    $('decode-format').value='auto'; example=true;decode();
  });
  $('decode-clear').addEventListener('click',()=>{$('decode-input').value='';result=null;example=false;render();message('粘贴解析内容已清空，实时采集记录保持不变。');});
  $('decode-copy').addEventListener('click',async()=>{
    if(!result?.text)return;
    try {await navigator.clipboard.writeText(result.text);message('解码文本已复制。');}
    catch { $('decode-output').focus();$('decode-output').select();message('浏览器未允许自动复制；已选中文本，请按 Ctrl+C。'); }
  });
  $('decode-save').addEventListener('click',()=>{if(result?.text)download(result.text,'text/plain;charset=utf-8','uart-decoded.txt');});
  $('decode-csv').addEventListener('click',()=>{if(result?.windows.length)download(wheelCsv(result.windows),'text/csv;charset=utf-8','uart-vibration.csv');});
  $('decode-import').addEventListener('click',()=>$('decode-file').click());
  $('decode-file').addEventListener('change',async()=>{
    const file=$('decode-file').files?.[0];if(!file)return;
    try {
      if(file.size>MAX_LOG_CHARS)throw new Error('文件最多2 MiB，请分段导入');
      $('decode-input').value=new TextDecoder($('decode-encoding').value||'utf-8').decode(await file.arrayBuffer());
      example=false;decode();
    }catch(error){message(error.message,true);}
    finally{$('decode-file').value='';}
  });
  render();
}

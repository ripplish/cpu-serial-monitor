import { LineFramer } from './protocol.mjs?v=20261026.1';

export const SERIAL_RECEIVER_VERSION = '20261026.1';

export function serialErrorText(error) {
  const reasons = {
    BreakError: '线路出现持续低电平，可能是板卡复位或串口信号中断',
    FramingError: '帧格式错误，请检查波特率和串口信号',
    ParityError: '校验错误，请确认串口使用 8N1',
    BufferOverrunError: '接收缓冲区溢出，有数据丢失',
    NetworkError: '串口设备已失去连接，请检查 USB 线和供电',
  };
  const detail = [error?.name, error?.message].filter(Boolean).join(': ');
  return reasons[error?.name] ? `${reasons[error.name]}（${detail}）` : detail || '未知读取错误';
}

export class SerialSession {
  constructor({ onLine, onOverflow, onEnd, onRecoverable = () => {}, onResumed = () => {} }) {
    this.onEnd = onEnd;
    this.onRecoverable = onRecoverable;
    this.awaitingResume = false; this.recoveredErrors = 0;
    this.framer = new LineFramer(line => {
      onLine(line);
      if (this.awaitingResume && line.trim()) {
        this.awaitingResume = false;
        onResumed(this.recoveredErrors);
      }
    }, onOverflow);
    this.port = null; this.reader = null; this.stopping = false; this.readTask = null;
    this.writer=null; this.writeTask=null; this.ending=false;
  }
  async connect(serial, baudRate) {
    if(this.port)throw new Error('串口已经连接，请先断开');
    // requestPort must be invoked inside the user's click activation.
    const port = await serial.requestPort();
    this.port = port;
    try { await port.open({ baudRate, bufferSize: 65536, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' }); }
    catch (error) { this.port = null; throw error; }
    this.stopping = false;
    this.ending=false; this.readTask=null;
    this.awaitingResume = false; this.recoveredErrors = 0;
    this.framer.reset();
    return port;
  }
  start() { this.readTask = this.read(); }
  async sendCommand(command) {
    if(!['C','R'].includes(command)) throw new Error('只支持 C 学习或 R 清除命令');
    if(this.stopping || this.ending || !this.port?.writable || !this.readTask) throw new Error('请先连接可写的真实串口');
    if(this.writer) throw new Error('上一条命令仍在发送，请稍后再试');
    const writer=this.port.writable.getWriter(); this.writer=writer;
    const task=(async()=>{
      try { await writer.write(new Uint8Array([command.charCodeAt(0)])); }
      finally { writer.releaseLock(); if(this.writer===writer)this.writer=null; }
    })();
    this.writeTask=task;
    try { await task; }
    finally { if(this.writeTask===task)this.writeTask=null; }
  }
  async cancelWrite() {
    const writer=this.writer,task=this.writeTask;
    if(writer) { try { await writer.abort(new Error('串口连接正在结束')); } catch { /* A removed device can already have failed. */ } }
    if(task) { try { await task; } catch { /* The sender reports write failure. */ } }
  }
  async read() {
    let failure = null;
    let decoder = new TextDecoder(), resync = false, consecutiveErrors = 0, recovered = 0;
    try {
      if (!this.port?.readable) throw new Error('设备没有可读的串口数据流');
      while (!this.stopping && this.port?.readable) {
        const stream = this.port.readable;
        this.reader = stream.getReader();
        let readError = null;
        try {
          while (!this.stopping) {
            let packet;
            try { packet = await this.reader.read(); }
            catch (error) { readError = error; break; }
            if (packet.done) break;
            if (!packet.value?.length) continue;
            consecutiveErrors = 0;
            let chunk = decoder.decode(packet.value, { stream: true });
            // A driver error can lose bytes. Never join either side into a valid-looking frame.
            if (resync) {
              const newline = chunk.indexOf('\n');
              if (newline < 0) continue;
              chunk = chunk.slice(newline + 1); resync = false;
            }
            this.framer.push(chunk);
          }
        } finally { this.reader.releaseLock(); this.reader = null; }
        if (this.stopping || !readError) break;
        // Web Serial replaces readable after a recoverable driver error; unplugging sets it to null.
        // Retrying the same errored stream would spin forever, so only use a new stream.
        const replacement = this.port?.readable;
        if (!replacement || replacement === stream || ++consecutiveErrors > 5) throw readError;
        this.framer.reset(); decoder = new TextDecoder(); resync = true;
        this.awaitingResume = true; this.recoveredErrors = recovered + 1;
        this.onRecoverable(readError, ++recovered);
      }
    } catch (error) { if (!this.stopping) failure = error; }
    finally {
      this.ending=true;
      this.reader?.releaseLock(); this.reader = null;
      await this.cancelWrite();
      try { if (this.port) await this.port.close(); } catch (error) { if (!this.stopping && !failure) failure = error; }
      this.port = null;
      this.framer.reset();
      this.onEnd(failure, this.stopping);
    }
  }
  async disconnect() {
    this.stopping = true;
    try { await this.reader?.cancel(); } catch { /* An unplugged device can already be closed. */ }
    if (this.readTask) await this.readTask;
    else if (this.port) { try { await this.port.close(); } finally { this.port = null; } }
  }
}

import { LineFramer } from './protocol.mjs';

export class SerialSession {
  constructor({ onLine, onOverflow, onEnd }) {
    this.onEnd = onEnd;
    this.framer = new LineFramer(onLine, onOverflow);
    this.port = null; this.reader = null; this.stopping = false; this.readTask = null;
  }
  async connect(serial, baudRate) {
    // requestPort must be invoked inside the user's click activation.
    const port = await serial.requestPort();
    this.port = port;
    try { await port.open({ baudRate, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' }); }
    catch (error) { this.port = null; throw error; }
    this.stopping = false;
    this.framer.reset();
    return port;
  }
  start() { this.readTask = this.read(); }
  async read() {
    let failure = null;
    const decoder = new TextDecoder();
    try {
      if (!this.port?.readable) throw new Error('设备没有可读的串口数据流');
      this.reader = this.port.readable.getReader();
      while (!this.stopping) {
        const { value, done } = await this.reader.read();
        if (done) break;
        this.framer.push(decoder.decode(value, { stream: true }));
      }
    } catch (error) { if (!this.stopping) failure = error; }
    finally {
      this.reader?.releaseLock(); this.reader = null;
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

import pty from 'node-pty';
import os from 'os';

// Singleton PTY session for the gateway
class PTYManager {
  private static instance: PTYManager;
  private ptyProcess: pty.IPty | null = null;
  private outputBuffer: string[] = [];
  private listeners: ((data: string) => void)[] = [];

  private constructor() {
    this.start();
  }

  static getInstance() {
    if (!PTYManager.instance) {
      PTYManager.instance = new PTYManager();
    }
    return PTYManager.instance;
  }

  private start() {
    if (this.ptyProcess) return;
    const shell = os.platform() === 'win32' ? 'powershell.exe' : 'bash';
    this.ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-color',
      cols: 120,
      rows: 30,
      cwd: process.cwd(),
      env: process.env as any,
    });
    this.ptyProcess.onData(data => {
      this.outputBuffer.push(data);
      this.listeners.forEach(fn => fn(data));
    });
  }

  runCommand(cmd: string): Promise<string> {
    return new Promise(resolve => {
      let output = '';
      const onData = (data: string) => {
        output += data;
      };
      this.listeners.push(onData);
      this.ptyProcess!.write(cmd + (os.platform() === 'win32' ? '\r' : '\n'));
      // Wait for prompt or short delay
      setTimeout(() => {
        this.listeners = this.listeners.filter(fn => fn !== onData);
        resolve(output);
      }, 2000);
    });
  }

  onOutput(fn: (data: string) => void) {
    this.listeners.push(fn);
  }

  getBuffer() {
    return this.outputBuffer.join('');
  }
}

export default PTYManager;

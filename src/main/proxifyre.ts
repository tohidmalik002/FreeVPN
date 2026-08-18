// ProxiFyre integration — the "capture" half of per-app split tunnelling.
//
// ProxiFyre (https://github.com/wiresock/proxifyre, built on the Windows Packet
// Filter driver) forces a chosen app's TCP into a local SOCKS5 proxy. We point
// it at our SplitProxy (127.0.0.1:1080), so the selected apps' traffic exits via
// the VPN while everything else stays direct.
//
// ProxiFyre + its driver are NOT bundled (a driver install needs admin and is a
// user choice). We detect it; if it's absent, split mode still connects, just
// without per-app capture, and the UI says so. This keeps normal VPN use
// completely unaffected.
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { guardChildProcess } from './jobguard';

export interface ProxifyreInfo {
  found: boolean;
  path?: string;
}

/** Look for a bundled/side-by-side ProxiFyre.exe. */
export function locateProxifyre(appRoot: string): ProxifyreInfo {
  const candidates = [
    path.join(appRoot, 'vendor', 'proxifyre', 'ProxiFyre.exe'),
    path.join(appRoot, 'vendor', 'ProxiFyre', 'ProxiFyre.exe'),
    'C:\\Program Files\\ProxiFyre\\ProxiFyre.exe',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return { found: true, path: p };
  }
  return { found: false };
}

export class ProxifyreManager {
  private proc: ChildProcess | null = null;

  get running(): boolean {
    return this.proc !== null;
  }

  /**
   * Start ProxiFyre routing the given executables into the SOCKS proxy on
   * 127.0.0.1:<port>. Writes app-config.json next to ProxiFyre.exe.
   */
  start(
    proxifyrePath: string,
    exes: string[],
    port: number,
    log: (line: string) => void,
  ): void {
    if (this.proc) this.stop();

    const dir = path.dirname(proxifyrePath);
    const config = {
      logLevel: 'Info',
      proxies: [
        {
          appNames: exes, // e.g. ["chrome.exe","firefox.exe"] — substring-matched
          socks5ProxyEndpoint: `127.0.0.1:${port}`,
          supportedProtocols: ['TCP'],
        },
      ],
    };
    fs.writeFileSync(
      path.join(dir, 'app-config.json'),
      JSON.stringify(config, null, 2),
      'utf8',
    );

    log(`[split] starting ProxiFyre for: ${exes.join(', ')}`);
    const proc = spawn(proxifyrePath, [], { cwd: dir, windowsHide: true });
    this.proc = proc;

    // If the app dies, ProxiFyre dies too (no lingering capture).
    guardChildProcess(proc.pid);

    const onData = (buf: Buffer) => {
      const line = buf.toString('utf8').trim();
      if (line) log(`[proxifyre] ${line}`);
    };
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
    proc.on('error', (e) => log(`[split] ProxiFyre error: ${e.message}`));
    proc.on('close', () => {
      if (this.proc === proc) this.proc = null;
    });
  }

  stop(): void {
    if (!this.proc) return;
    try {
      this.proc.kill();
    } catch {
      /* ignore */
    }
    this.proc = null;
  }
}

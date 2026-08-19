// Locates and drives the OpenVPN Community CLI (openvpn.exe).
//
// This intentionally uses the *Community* edition, which coexists with (and is
// completely independent of) the enterprise "OpenVPN Connect" client — we never
// read or touch Connect's profiles.
import { spawn, ChildProcessWithoutNullStreams, execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import { guardChildProcess } from './jobguard';
import { OpenVpnInfo, VpnServer, VpnStatus } from '../shared/types';

const COMMUNITY_PATHS: Array<{ p: string; source: OpenVpnInfo['source'] }> = [
  { p: 'C:\\Program Files\\OpenVPN\\bin\\openvpn.exe', source: 'community' },
  {
    p: 'C:\\Program Files (x86)\\OpenVPN\\bin\\openvpn.exe',
    source: 'community-x86',
  },
];

/**
 * Find an openvpn.exe. Priority:
 *   1. a copy bundled with the app under vendor/openvpn/ (makes it standalone)
 *   2. an installed OpenVPN Community edition
 */
export function locateOpenVpn(appRoot: string): OpenVpnInfo {
  const bundled = path.join(appRoot, 'vendor', 'openvpn', 'openvpn.exe');
  if (fs.existsSync(bundled)) {
    return { found: true, path: bundled, source: 'bundled' };
  }
  for (const { p, source } of COMMUNITY_PATHS) {
    if (fs.existsSync(p)) return { found: true, path: p, source };
  }
  return { found: false };
}

/** True if the current process is running elevated (has admin rights). */
export function isAdmin(): Promise<boolean> {
  return new Promise((resolve) => {
    // `net session` requires administrator rights; it errors otherwise.
    execFile('net', ['session'], { windowsHide: true }, (err) => {
      resolve(!err);
    });
  });
}

/**
 * Manages a single OpenVPN connection: writes the .ovpn to a temp file, spawns
 * openvpn.exe, and translates its stdout into VpnStatus updates.
 *
 * Events:
 *   'status' (VpnStatus)  — phase changes
 *   'log'    (string)     — raw openvpn output lines
 */
export class OpenVpnManager extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private configPath: string | null = null;
  private current: VpnServer | null = null;
  private status: VpnStatus = { phase: 'disconnected' };

  getStatus(): VpnStatus {
    return this.status;
  }

  private setStatus(next: VpnStatus): void {
    this.status = { ...next, since: Date.now() };
    this.emit('status', this.status);
  }

  private log(line: string): void {
    this.emit('log', line);
  }

  async connect(
    server: VpnServer,
    openvpnPath: string,
    opts: { splitTunnel?: boolean } = {},
  ): Promise<void> {
    if (this.proc) {
      await this.disconnect();
    }

    const cfg = Buffer.from(server.configBase64, 'base64').toString('utf8');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freevpn-'));
    this.configPath = path.join(dir, 'server.ovpn');
    fs.writeFileSync(this.configPath, cfg, 'utf8');

    this.current = server;
    this.setStatus({
      phase: 'connecting',
      server: {
        hostName: server.hostName,
        countryLong: server.countryLong,
        countryShort: server.countryShort,
      },
    });

    // Robustness flags on top of the server's own config:
    //  - data-ciphers*: many VPN Gate configs still specify legacy ciphers that
    //    OpenVPN 2.6 rejects by default; allow negotiation + a CBC fallback.
    //  - connect-timeout / retry-max: fail fast on a dead relay instead of hanging.
    const args = [
      '--config',
      this.configPath,
      '--data-ciphers',
      'AES-256-GCM:AES-128-GCM:AES-128-CBC:AES-256-CBC',
      '--data-ciphers-fallback',
      'AES-128-CBC',
      '--connect-timeout',
      '12',
      '--connect-retry-max',
      '1',
      '--pull-filter',
      'ignore',
      'block-outside-dns',
    ];

    // Split-tunnel mode: don't let the server make the tunnel the default route.
    // The tunnel adapter still comes up with an IP, so specific apps can be routed
    // through it (see tools/split-proxy.js), while the rest of the system stays direct.
    if (opts.splitTunnel) {
      args.push('--pull-filter', 'ignore', 'redirect-gateway');
      args.push('--pull-filter', 'ignore', 'redirect-gateway-ipv6');
      this.log('[split] split-tunnel mode: tunnel will NOT be the default route');
    }

    this.log(`$ openvpn --config server.ovpn  (${server.hostName})`);
    const proc = spawn(openvpnPath, args, {
      cwd: path.dirname(openvpnPath), // so wintun.dll next to openvpn.exe is found
      windowsHide: true,
    });
    this.proc = proc;

    // Tie the tunnel's lifetime to the app: if the app dies for ANY reason
    // (crash, Task Manager, taskkill /F), the OS kills openvpn.exe too.
    const armed = guardChildProcess(proc.pid);
    this.log(
      armed
        ? '[guard] kill-on-exit armed — tunnel will stop if the app is killed'
        : '[guard] kill-on-exit unavailable — relying on graceful shutdown only',
    );

    const onData = (buf: Buffer) => {
      for (const line of buf.toString('utf8').split(/\r?\n/)) {
        if (line.trim()) this.handleLine(line);
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);

    proc.on('error', (err) => {
      this.setStatus({ phase: 'error', message: err.message });
      this.cleanup();
    });

    proc.on('close', (code) => {
      // A failure was often already reported by handleLine (e.g. AUTH_FAILED);
      // don't emit a second 'error' for the same attempt.
      if (this.status.phase === 'error') {
        this.cleanup();
        return;
      }
      if (this.status.phase === 'disconnecting') {
        this.setStatus({ phase: 'disconnected' });
      } else if (this.status.phase === 'connected') {
        this.setStatus({ phase: 'disconnected', message: 'Connection closed' });
      } else {
        this.setStatus({
          phase: 'error',
          message: `openvpn exited (code ${code ?? 'null'})`,
        });
      }
      this.cleanup();
    });
  }

  private handleLine(line: string): void {
    this.log(line);

    if (/Initialization Sequence Completed/i.test(line)) {
      const s = this.current;
      this.setStatus({
        phase: 'connected',
        server: s
          ? {
              hostName: s.hostName,
              countryLong: s.countryLong,
              countryShort: s.countryShort,
            }
          : undefined,
      });
      return;
    }

    if (/AUTH_FAILED/i.test(line)) {
      this.setStatus({ phase: 'error', message: 'Authentication failed' });
      return;
    }
    if (/There are no TAP-Windows|All TAP-Windows adapters|Cannot find/i.test(line)) {
      this.setStatus({
        phase: 'error',
        message:
          'No VPN network adapter found — reinstall OpenVPN Community with the default options.',
      });
      return;
    }
    if (/Note: cannot open .* for reading|WARNING: cannot stat/i.test(line)) {
      // non-fatal
    }
  }

  async disconnect(): Promise<void> {
    if (!this.proc) {
      this.setStatus({ phase: 'disconnected' });
      return;
    }
    this.setStatus({ phase: 'disconnecting' });
    const proc = this.proc;
    return new Promise((resolve) => {
      const done = () => resolve();
      proc.once('close', done);
      // SIGTERM lets openvpn tear the adapter/routes down cleanly.
      proc.kill('SIGTERM');
      // Hard stop if it ignores us.
      setTimeout(() => {
        if (this.proc === proc) {
          try {
            proc.kill('SIGKILL');
          } catch {
            /* ignore */
          }
        }
      }, 4000);
    });
  }

  private cleanup(): void {
    this.proc = null;
    this.current = null;
    if (this.configPath) {
      try {
        fs.rmSync(path.dirname(this.configPath), { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      this.configPath = null;
    }
  }
}

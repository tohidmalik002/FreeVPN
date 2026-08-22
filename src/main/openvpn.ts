// Locates and drives the OpenVPN Community CLI (openvpn.exe).
//
// This intentionally uses the *Community* edition, which coexists with (and is
// completely independent of) the enterprise "OpenVPN Connect" client — we never
// read or touch Connect's profiles.
import { spawn, ChildProcessWithoutNullStreams, execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as net from 'net';
import { EventEmitter } from 'events';
import { guardChildProcess } from './jobguard';
import { OpenVpnInfo, VpnServer, VpnStatus } from '../shared/types';

const COMMUNITY_PATHS: Array<{ p: string; source: OpenVpnInfo['source'] }> =
  process.platform === 'linux'
    ? [
        { p: '/usr/sbin/openvpn', source: 'community' },
        { p: '/usr/bin/openvpn', source: 'community' },
      ]
    : [
        { p: 'C:\\Program Files\\OpenVPN\\bin\\openvpn.exe', source: 'community' },
        {
          p: 'C:\\Program Files (x86)\\OpenVPN\\bin\\openvpn.exe',
          source: 'community-x86',
        },
      ];

/**
 * Find an openvpn binary. Priority:
 *   1. a copy bundled with the app under vendor/openvpn/ (makes it standalone)
 *   2. an installed OpenVPN Community edition (apt package `openvpn` on Linux)
 */
export function locateOpenVpn(appRoot: string): OpenVpnInfo {
  const bundledName = process.platform === 'linux' ? 'openvpn' : 'openvpn.exe';
  const bundled = path.join(appRoot, 'vendor', 'openvpn', bundledName);
  if (fs.existsSync(bundled)) {
    return { found: true, path: bundled, source: 'bundled' };
  }
  for (const { p, source } of COMMUNITY_PATHS) {
    if (fs.existsSync(p)) return { found: true, path: p, source };
  }
  return { found: false };
}

/**
 * True if the current process is running elevated (has admin rights).
 *
 * On Linux we deliberately never run the whole app as root (see connect()) —
 * elevation is scoped to just the openvpn child via pkexec — so this always
 * reports true and the UI never nags the user to relaunch elevated.
 */
export function isAdmin(): Promise<boolean> {
  if (process.platform === 'linux') return Promise.resolve(true);
  return new Promise((resolve) => {
    // `net session` requires administrator rights; it errors otherwise.
    execFile('net', ['session'], { windowsHide: true }, (err) => {
      resolve(!err);
    });
  });
}

/** Ask the OS for a free TCP port by binding to port 0 and reading it back. */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Send a command to openvpn's management interface (loopback TCP) and close.
 * Used on Linux instead of proc.kill() because openvpn runs as root there
 * (via pkexec) and this unprivileged process cannot signal it directly.
 */
function sendManagementCommand(port: number, command: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(command + '\n');
      sock.end();
    });
    sock.setTimeout(3000, () => sock.destroy(new Error('management command timed out')));
    sock.once('close', () => resolve());
    sock.once('error', reject);
  });
}

/** Sleep helper for the retry loop below. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry sendManagementCommand for a bit before giving up.
 *
 * Right after connect() spawns openvpn, its management listener may not be
 * up yet (it opens after openvpn parses args, which takes a moment). Calling
 * disconnect() in that window — e.g. Fastest failover moving on from a
 * server that's failing fast — used to hit ECONNREFUSED once and fall
 * straight through to the pkexec-kill fallback, which re-prompts for a
 * password. Retrying for ~2s covers that window so the common case doesn't
 * need a second elevation at all.
 */
async function sendManagementCommandWithRetry(port: number, command: string): Promise<void> {
  const attempts = 10;
  for (let i = 0; i < attempts; i++) {
    try {
      await sendManagementCommand(port, command);
      return;
    } catch (err) {
      if (i === attempts - 1) throw err;
      await delay(200);
    }
  }
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
  private mgmtPort: number | null = null; // Linux only — see sendManagementCommand
  private tunDevice: string | null = null; // Linux only — e.g. "tun0", for split-tunnel routing

  getStatus(): VpnStatus {
    return this.status;
  }

  /** The kernel tun interface openvpn brought up (Linux only, once connected). */
  getTunDevice(): string | null {
    return this.tunDevice;
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

    let proc: ChildProcessWithoutNullStreams;
    if (process.platform === 'linux') {
      // openvpn needs root to create the tun device and set routes. We never
      // run the whole app as root — pkexec elevates just this one child and
      // shows the desktop's own polkit auth dialog.
      this.mgmtPort = await getFreePort();
      args.push('--management', '127.0.0.1', String(this.mgmtPort));
      this.log(`$ pkexec openvpn --config server.ovpn  (${server.hostName})`);
      proc = spawn('pkexec', [openvpnPath, ...args], {
        cwd: path.dirname(openvpnPath),
      });
    } else {
      this.log(`$ openvpn --config server.ovpn  (${server.hostName})`);
      proc = spawn(openvpnPath, args, {
        cwd: path.dirname(openvpnPath), // so wintun.dll next to openvpn.exe is found
        windowsHide: true,
      });
    }
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
      } else if (process.platform === 'linux' && code === 126) {
        this.setStatus({ phase: 'error', message: 'Authorization was cancelled' });
      } else if (process.platform === 'linux' && code === 127) {
        this.setStatus({
          phase: 'error',
          message: 'Not authorized to run openvpn as root (pkexec denied it)',
        });
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

    if (process.platform === 'linux' && !this.tunDevice) {
      const m = line.match(/\b(tun\d+)\b/);
      if (m) this.tunDevice = m[1];
    }

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
    if (/Cannot open TUN\/TAP dev|Cannot allocate TUN\/TAP/i.test(line)) {
      this.setStatus({
        phase: 'error',
        message: 'Could not open /dev/net/tun — is the "tun" kernel module loaded?',
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
    if (process.platform === 'linux' && this.mgmtPort) {
      // openvpn runs as root (pkexec); this process cannot signal it directly,
      // so ask it to shut down over its own management interface instead.
      // Retried because disconnect() can land moments after connect(), before
      // openvpn's management listener has opened (e.g. Fastest failover
      // abandoning a server that's already failing) — a single failed attempt
      // used to fall straight through to the pkexec-kill fallback below,
      // which re-prompts for a password.
      await sendManagementCommandWithRetry(this.mgmtPort, 'signal SIGTERM').catch(() => undefined);
    }
    return new Promise((resolve) => {
      const done = () => resolve();
      proc.once('close', done);
      if (process.platform !== 'linux') {
        // SIGTERM lets openvpn tear the adapter/routes down cleanly.
        proc.kill('SIGTERM');
      }
      // Hard stop if it ignores us.
      setTimeout(() => {
        if (this.proc !== proc) return;
        if (process.platform === 'linux') {
          // Last resort — the management channel should normally handle this.
          // Re-elevates (a second auth prompt), so only used on a stuck tunnel.
          execFile('pkexec', ['kill', '-TERM', String(proc.pid)], () => undefined);
        } else {
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
    this.mgmtPort = null;
    this.tunDevice = null;
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

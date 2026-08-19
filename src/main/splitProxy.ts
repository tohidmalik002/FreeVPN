// In-process SOCKS5 proxy whose outbound traffic exits via the VPN tunnel.
//
// This is the egress half of per-app split tunnelling. ProxiFyre (see
// proxifyre.ts) forces a chosen app's traffic into this proxy; the proxy then
// dials the real destination bound to the VPN adapter's IP, with a temporary
// per-destination host route through the tunnel. The rest of the system is
// untouched.
//
// Standalone equivalent / test harness: tools/split-proxy.js.
import * as net from 'net';
import * as dns from 'dns';
import { execFile } from 'child_process';

interface VpnAdapter {
  name: string;
  ifIndex: number;
  ip: string;
  gateway: string; // tunnel next-hop (peer) — required to route hosts into the tunnel
}

/** For a /30 point-to-point link, the peer is the other usable host address. */
function computePeer(ip: string): string {
  const p = ip.split('.').map(Number);
  const base = p[3] & 0xfc; // /30 network's last octet
  const h1 = base + 1;
  const h2 = base + 2;
  p[3] = p[3] === h1 ? h2 : h1;
  return p.join('.');
}

function ps(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', command],
      { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout.trim())),
    );
  });
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true }, () => resolve());
  });
}

export class SplitProxy {
  private server: net.Server | null = null;
  private routeRefs = new Map<string, number>();
  private vpn: VpnAdapter | null = null;

  constructor(private log: (line: string) => void) {}

  get running(): boolean {
    return this.server !== null;
  }

  private async findVpnAdapter(): Promise<VpnAdapter> {
    const json = await ps(
      "Get-NetAdapter | Where-Object { $_.Status -eq 'Up' } | " +
        'Select-Object Name, InterfaceIndex, InterfaceDescription | ConvertTo-Json -Compress',
    );
    let adapters = JSON.parse(json || '[]');
    if (!Array.isArray(adapters)) adapters = adapters ? [adapters] : [];
    const looksVpn = (a: { InterfaceDescription?: string }) =>
      /wintun|tap-windows|tap-openvpn|openvpn/i.test(a.InterfaceDescription || '');

    const candidates = adapters.filter(looksVpn);
    for (const a of candidates.length ? candidates : adapters) {
      const ipJson = await ps(
        `Get-NetIPAddress -InterfaceIndex ${a.InterfaceIndex} -AddressFamily IPv4 ` +
          '-ErrorAction SilentlyContinue | Select-Object IPAddress | ConvertTo-Json -Compress',
      );
      if (!ipJson) continue;
      let ips = JSON.parse(ipJson);
      if (!Array.isArray(ips)) ips = [ips];
      const ip = ips
        .map((x: { IPAddress: string }) => x.IPAddress)
        .find((x: string) => x && !x.startsWith('169.254'));
      if (ip && looksVpn(a)) {
        // Find the tunnel next-hop (gateway). Prefer the adapter's configured
        // gateway; fall back to the /30 peer address.
        let gateway = '';
        try {
          const g = await ps(
            `(Get-NetIPConfiguration -InterfaceIndex ${a.InterfaceIndex}` +
              ' -ErrorAction SilentlyContinue).IPv4DefaultGateway.NextHop',
          );
          if (g && /^\d+\.\d+\.\d+\.\d+$/.test(g.trim())) gateway = g.trim();
        } catch {
          /* fall through */
        }
        if (!gateway) gateway = computePeer(ip);
        return { name: a.Name, ifIndex: a.InterfaceIndex, ip, gateway };
      }
    }
    throw new Error('no VPN tunnel adapter found (is the VPN connected?)');
  }

  private async addRoute(destIp: string): Promise<void> {
    const n = this.routeRefs.get(destIp) || 0;
    this.routeRefs.set(destIp, n + 1);
    if (n === 0 && this.vpn) {
      await run('netsh', [
        'interface', 'ipv4', 'add', 'route',
        `${destIp}/32`, `interface=${this.vpn.ifIndex}`,
        `nexthop=${this.vpn.gateway}`, 'store=active',
      ]);
    }
  }

  private async delRoute(destIp: string): Promise<void> {
    const n = this.routeRefs.get(destIp) || 0;
    if (n <= 1) {
      this.routeRefs.delete(destIp);
      if (this.vpn) {
        await run('netsh', [
          'interface', 'ipv4', 'delete', 'route',
          `${destIp}/32`, `interface=${this.vpn.ifIndex}`,
          `nexthop=${this.vpn.gateway}`,
        ]);
      }
    } else {
      this.routeRefs.set(destIp, n - 1);
    }
  }

  private handleClient(socket: net.Socket): void {
    socket.once('data', (greeting: Buffer) => {
      if (greeting[0] !== 0x05) return socket.destroy();
      socket.write(Buffer.from([0x05, 0x00]));

      socket.once('data', async (req: Buffer) => {
        if (req[0] !== 0x05 || req[1] !== 0x01) {
          socket.write(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          return socket.destroy();
        }
        const atyp = req[3];
        let host = '';
        let portOffset = 0;
        try {
          if (atyp === 0x01) {
            host = `${req[4]}.${req[5]}.${req[6]}.${req[7]}`;
            portOffset = 8;
          } else if (atyp === 0x03) {
            const len = req[4];
            host = req.slice(5, 5 + len).toString('utf8');
            portOffset = 5 + len;
          } else {
            socket.write(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            return socket.destroy();
          }
          const port = req.readUInt16BE(portOffset);
          const destIp: string = await new Promise((res, rej) =>
            dns.lookup(host, { family: 4 }, (e, addr) => (e ? rej(e) : res(addr))),
          );
          await this.addRoute(destIp);
          this.log(`[split] → ${host}:${port} (${destIp}) via tunnel`);

          const upstream = net.connect(
            { host: destIp, port, localAddress: this.vpn!.ip },
            () => {
              socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
              upstream.pipe(socket);
              socket.pipe(upstream);
            },
          );
          let released = false;
          const release = () => {
            if (released) return;
            released = true;
            this.delRoute(destIp).catch(() => undefined);
          };
          upstream.on('close', release);
          upstream.on('error', () => {
            release();
            if (!socket.destroyed) {
              socket.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
              socket.destroy();
            }
          });
          socket.on('close', () => upstream.destroy());
        } catch (e) {
          if (!socket.destroyed) {
            socket.write(Buffer.from([0x05, 0x04, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            socket.destroy();
          }
        }
      });
    });
    socket.on('error', () => undefined);
  }

  /** Start the proxy. Resolves once it is listening. */
  async start(port = 1080): Promise<void> {
    if (this.server) return;
    this.vpn = await this.findVpnAdapter();
    this.log(
      `[split] proxy egress via ${this.vpn.name} (ip=${this.vpn.ip}, ` +
        `gw=${this.vpn.gateway}) on 127.0.0.1:${port}`,
    );
    await new Promise<void>((resolve, reject) => {
      const server = net.createServer((s) => this.handleClient(s));
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        this.server = server;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    // remove any host routes we added
    for (const destIp of Array.from(this.routeRefs.keys())) {
      if (this.vpn) {
        await run('netsh', [
          'interface', 'ipv4', 'delete', 'route',
          `${destIp}/32`, `interface=${this.vpn.ifIndex}`,
        ]);
      }
    }
    this.routeRefs.clear();
  }
}

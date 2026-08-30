// Linux per-app split tunnelling — the Linux counterpart to proxifyre.ts.
//
// Windows has no transparent way to capture an *already-running* process's
// traffic without a signed packet-filter driver (ProxiFyre). Linux has no
// equivalent driver, and retrofitting network isolation onto a process that's
// already running needs heavy tooling (CRIU) that isn't worth the complexity
// here. Instead we use the standard, well-supported primitive for this on
// Linux — a network namespace whose only route out is the VPN tunnel — and
// *launch* the chosen app inside it. That's a real UX difference from
// Windows ("pick a running app" becomes "pick an app to launch through the
// VPN"), but it gets full TCP+UDP+DNS isolation for free, which the Windows
// SOCKS5 proxy (splitProxy.ts) never had (see docs/SPLIT-TUNNEL.md).
//
// The privileged setup (namespace/veth/routes/iptables) lives in
// scripts/linux-split-up.sh and linux-split-down.sh, run once per connection
// via pkexec — never the whole app. Apps are then launched inside the
// namespace as the invoking (non-root) user via `runuser`, so the app itself
// never runs elevated.
import { execFile, spawn } from 'child_process';
import * as os from 'os';
import * as path from 'path';

const NETNS = 'freevpn0';
const VETH_HOST = 'veth-fvpn0';
const VETH_NS = 'veth-fvpn1';
const HOST_CIDR = '10.200.100.1/30';
const NS_CIDR = '10.200.100.2/30';
// No DNS is pulled from the server today (the CLI needs an --up script for
// that, which we don't run) — route lookups through public resolvers via the
// tunnel rather than leaking them to the host's normal DNS. See "Still to
// do" in docs/SPLIT-TUNNEL.md.
const DNS_SERVERS = ['1.1.1.1', '9.9.9.9'];

function run(cmd: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, (err, _stdout, stderr) => {
      const code = err && 'code' in err && typeof err.code === 'number' ? err.code : err ? 1 : 0;
      resolve({ code, stderr: stderr ? stderr.toString() : '' });
    });
  });
}

export class LinuxSplitTunnel {
  private up = false;

  constructor(
    private scriptsDir: string,
    private log: (line: string) => void,
  ) {}

  get running(): boolean {
    return this.up;
  }

  /** Bring the routing namespace up, wired to the given tun device. */
  async start(tunDevice: string): Promise<void> {
    if (this.up) return;
    const script = path.join(this.scriptsDir, 'linux-split-up.sh');
    this.log(`[split] setting up a routing namespace for ${tunDevice} (needs root — pkexec)`);
    const { code, stderr } = await run('pkexec', [
      script,
      NETNS,
      VETH_HOST,
      VETH_NS,
      HOST_CIDR,
      NS_CIDR,
      tunDevice,
      ...DNS_SERVERS,
    ]);
    if (code !== 0) {
      throw new Error(
        `routing namespace setup failed (code ${code})${stderr.trim() ? `: ${stderr.trim()}` : ''}`,
      );
    }
    this.up = true;
    this.log('[split] routing namespace ready — use "Launch in tunnel" on a chosen app');
  }

  /**
   * Tear the namespace down. Apps already launched inside it are left
   * running (killing someone's browser because the VPN disconnected would be
   * surprising) — they simply lose their route once the namespace is gone,
   * which is the intended kill-switch behaviour.
   */
  async stop(tunDevice: string): Promise<void> {
    if (!this.up) return;
    const script = path.join(this.scriptsDir, 'linux-split-down.sh');
    await run('pkexec', [script, NETNS, VETH_HOST, NS_CIDR, tunDevice]);
    this.up = false;
  }

  /** Launch an app inside the routing namespace, as the current (non-root) user. */
  launchApp(exePath: string): void {
    if (!this.up) throw new Error('the routing namespace is not up yet');
    const user = os.userInfo().username;
    this.log(`[split] launching ${exePath} in the routed namespace as ${user}`);
    const proc = spawn(
      'pkexec',
      ['ip', 'netns', 'exec', NETNS, 'runuser', '-u', user, '--', exePath],
      { stdio: 'ignore', detached: true },
    );
    proc.unref();
    proc.on('error', (e) => this.log(`[split] failed to launch ${exePath}: ${e.message}`));
  }
}

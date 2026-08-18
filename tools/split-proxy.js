#!/usr/bin/env node
/**
 * split-proxy.js — SOCKS5 proxy whose outbound traffic exits via the VPN tunnel.
 *
 * This is the egress half of per-app split tunnelling (Stage 0). Any client that
 * connects through this proxy (a browser, or later an app forced in by ProxiFyre)
 * has its traffic routed through the OpenVPN adapter, while the rest of the system
 * keeps using the normal connection.
 *
 * HOW: for each outbound connection we (1) add a host route to the destination via
 * the VPN interface, and (2) bind the outgoing socket's source address to the VPN
 * adapter's IP. Both together force that single connection out the tunnel. Routes
 * are reference-counted and removed when the last connection to a destination ends.
 *
 * REQUIREMENTS:
 *   - Run **as administrator** (adding routes needs it).
 *   - Connect FreeVPN first, ideally in SPLIT mode (so the tunnel is NOT the default
 *     route — otherwise everything is already on the VPN and there is nothing to prove).
 *
 * USAGE:
 *   node tools/split-proxy.js [--port 1080] [--adapter <name-substring>]
 *
 * Then set your browser's SOCKS5 proxy to 127.0.0.1:1080 and check your IP.
 *
 * LIMITATIONS (Stage 0): TCP only (no UDP/QUIC — browsers fall back to TCP over
 * HTTPS); DNS is resolved locally (possible DNS leak — refined in a later stage).
 */
'use strict';

const net = require('net');
const dns = require('dns');
const { execFile } = require('child_process');

// ---- args ----
const args = process.argv.slice(2);
function argVal(flag, def) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const PORT = parseInt(argVal('--port', '1080'), 10);
const ADAPTER_HINT = argVal('--adapter', '').toLowerCase();

// ---- helpers ----
function ps(command) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', command],
      { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout.trim())),
    );
  });
}

function run(cmd, cmdArgs) {
  return new Promise((resolve) => {
    execFile(cmd, cmdArgs, { windowsHide: true }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: (stdout || '') + (stderr || '') }),
    );
  });
}

/**
 * Find the OpenVPN tunnel adapter: an "Up" adapter whose description looks like
 * Wintun/TAP/OpenVPN, with an IPv4 address. Returns { name, ifIndex, ip }.
 */
async function findVpnAdapter() {
  const json = await ps(
    "Get-NetAdapter | Where-Object { $_.Status -eq 'Up' } | " +
      'Select-Object Name, InterfaceIndex, InterfaceDescription | ConvertTo-Json -Compress',
  );
  let adapters = JSON.parse(json || '[]');
  if (!Array.isArray(adapters)) adapters = [adapters];

  const looksVpn = (a) =>
    /wintun|tap-windows|tap-openvpn|openvpn/i.test(a.InterfaceDescription || '') ||
    (ADAPTER_HINT && (a.Name || '').toLowerCase().includes(ADAPTER_HINT));

  const candidates = adapters.filter(looksVpn);
  for (const a of candidates.length ? candidates : adapters) {
    const ipJson = await ps(
      `Get-NetIPAddress -InterfaceIndex ${a.InterfaceIndex} -AddressFamily IPv4 ` +
        '-ErrorAction SilentlyContinue | Select-Object IPAddress | ConvertTo-Json -Compress',
    );
    if (!ipJson) continue;
    let ips = JSON.parse(ipJson);
    if (!Array.isArray(ips)) ips = [ips];
    const ip = ips.map((x) => x.IPAddress).find((x) => x && !x.startsWith('169.254'));
    if (ip && looksVpn(a)) {
      return { name: a.Name, ifIndex: a.InterfaceIndex, ip };
    }
  }
  throw new Error(
    'No VPN tunnel adapter found. Is FreeVPN connected? (looked for Wintun/TAP/OpenVPN)',
  );
}

// ---- reference-counted host routes via the tunnel ----
const routeRefs = new Map(); // destIp -> count
let VPN = null;

async function addRoute(destIp) {
  const n = routeRefs.get(destIp) || 0;
  routeRefs.set(destIp, n + 1);
  if (n === 0) {
    await run('netsh', [
      'interface', 'ipv4', 'add', 'route',
      `${destIp}/32`, `interface=${VPN.ifIndex}`, 'store=active',
    ]);
  }
}

async function delRoute(destIp) {
  const n = routeRefs.get(destIp) || 0;
  if (n <= 1) {
    routeRefs.delete(destIp);
    await run('netsh', [
      'interface', 'ipv4', 'delete', 'route', `${destIp}/32`, `interface=${VPN.ifIndex}`,
    ]);
  } else {
    routeRefs.set(destIp, n - 1);
  }
}

async function cleanupAllRoutes() {
  for (const destIp of Array.from(routeRefs.keys())) {
    await run('netsh', [
      'interface', 'ipv4', 'delete', 'route', `${destIp}/32`, `interface=${VPN.ifIndex}`,
    ]);
  }
  routeRefs.clear();
}

// ---- minimal SOCKS5 (CONNECT only) ----
function handleClient(socket) {
  socket.once('data', (greeting) => {
    // greeting: ver, nmethods, methods...
    if (greeting[0] !== 0x05) return socket.destroy();
    socket.write(Buffer.from([0x05, 0x00])); // no-auth

    socket.once('data', async (req) => {
      // req: ver, cmd, rsv, atyp, addr, port
      if (req[0] !== 0x05 || req[1] !== 0x01) {
        // only CONNECT supported
        socket.write(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        return socket.destroy();
      }
      const atyp = req[3];
      let host, portOffset;
      try {
        if (atyp === 0x01) {
          host = `${req[4]}.${req[5]}.${req[6]}.${req[7]}`;
          portOffset = 8;
        } else if (atyp === 0x03) {
          const len = req[4];
          host = req.slice(5, 5 + len).toString('utf8');
          portOffset = 5 + len;
        } else if (atyp === 0x04) {
          // IPv6 not routed in this POC
          socket.write(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          return socket.destroy();
        } else {
          return socket.destroy();
        }
        const port = req.readUInt16BE(portOffset);

        // resolve to an IPv4 we can add a host route for
        const destIp = await new Promise((res, rej) =>
          dns.lookup(host, { family: 4 }, (e, addr) => (e ? rej(e) : res(addr))),
        );

        await addRoute(destIp);

        const upstream = net.connect(
          { host: destIp, port, localAddress: VPN.ip },
          () => {
            // success reply (bind addr/port are cosmetic here)
            socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            upstream.pipe(socket);
            socket.pipe(upstream);
          },
        );

        let routeReleased = false;
        const release = () => {
          if (routeReleased) return;
          routeReleased = true;
          delRoute(destIp).catch(() => {});
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
        console.log(`↳ ${host}:${port} (${destIp}) via ${VPN.name}`);
      } catch (e) {
        console.log(`✗ ${host || '?'} — ${e.message}`);
        if (!socket.destroyed) {
          socket.write(Buffer.from([0x05, 0x04, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          socket.destroy();
        }
      }
    });
  });
  socket.on('error', () => {});
}

// ---- main ----
(async () => {
  try {
    VPN = await findVpnAdapter();
  } catch (e) {
    console.error('ERROR:', e.message);
    process.exit(1);
  }
  console.log('VPN adapter :', VPN.name, `(ifIndex=${VPN.ifIndex}, ip=${VPN.ip})`);

  const server = net.createServer(handleClient);
  server.on('error', (e) => {
    console.error('Proxy server error:', e.message);
    process.exit(1);
  });
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`SOCKS5 proxy : 127.0.0.1:${PORT}`);
    console.log('\nSet your browser SOCKS5 proxy to 127.0.0.1:' + PORT + ', then visit');
    console.log('https://ifconfig.me — it should show the VPN country, while the rest');
    console.log('of your system (open a normal app) still shows your real IP.\n');
    console.log('Press Ctrl+C to stop and clean up routes.');
  });

  const shutdown = async () => {
    console.log('\nCleaning up host routes…');
    await cleanupAllRoutes();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
})();

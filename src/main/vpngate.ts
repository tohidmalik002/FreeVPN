// Fetches and parses the public VPN Gate server list.
//
// VPN Gate (https://www.vpngate.net) is a free academic volunteer VPN network
// run by the University of Tsukuba, Japan. Its iPhone/CSV endpoint returns a
// list of public relay servers, each carrying a full base64-encoded .ovpn file.
import * as https from 'https';
import { VpnServer } from '../shared/types';

// Mirrors — tried in order. The primary host is occasionally slow/blocked.
const API_URLS = [
  'https://www.vpngate.net/api/iphone/',
  'https://vpngate.net/api/iphone/',
];

function httpGet(url: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { 'User-Agent': 'FreeVPN/0.1 (+windows)' } },
      (res) => {
        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} from ${url}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
  });
}

/** Detect tcp/udp by peeking at the decoded .ovpn config. */
function detectProto(configBase64: string): 'tcp' | 'udp' | 'unknown' {
  try {
    const cfg = Buffer.from(configBase64, 'base64').toString('utf8');
    const m = cfg.match(/^\s*proto\s+(tcp|udp)/im);
    if (m) return m[1].toLowerCase() as 'tcp' | 'udp';
  } catch {
    /* ignore */
  }
  return 'unknown';
}

function parseCsv(text: string): VpnServer[] {
  const servers: VpnServer[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('*') || line.startsWith('#')) continue;

    // The .ovpn base64 is the LAST column and never contains a comma; the free-
    // text Message column (index 13) can, so we anchor on first/last fields.
    const parts = line.split(',');
    if (parts.length < 15) continue;

    const configBase64 = parts[parts.length - 1];
    if (!configBase64 || configBase64.length < 100) continue;

    const speedBps = Number(parts[4]) || 0;
    const server: VpnServer = {
      hostName: parts[0],
      ip: parts[1],
      score: Number(parts[2]) || 0,
      ping: Number(parts[3]) || 0,
      speedMbps: Math.round((speedBps / 1_000_000) * 10) / 10,
      countryLong: parts[5] || 'Unknown',
      countryShort: (parts[6] || '').toUpperCase(),
      sessions: Number(parts[7]) || 0,
      uptimeHours: Math.round((Number(parts[8]) || 0) / 3_600_000),
      proto: detectProto(configBase64),
      configBase64,
    };
    servers.push(server);
  }
  // Best first: highest score, then fastest.
  servers.sort((a, b) => b.score - a.score || b.speedMbps - a.speedMbps);
  return servers;
}

/** Fetch the current VPN Gate server list. Throws if every mirror fails. */
export async function fetchServers(): Promise<VpnServer[]> {
  let lastErr: unknown;
  for (const url of API_URLS) {
    try {
      const text = await httpGet(url, 20_000);
      const servers = parseCsv(text);
      if (servers.length > 0) return servers;
      lastErr = new Error('server list was empty');
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `Could not fetch the VPN Gate server list: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}

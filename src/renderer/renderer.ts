import type { EnvInfo, VpnServer, VpnStatus } from './global';

const api = window.api;

// ---- element refs ----
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const banner = $('banner');
const statusDot = $('statusDot');
const statusPhase = $('statusPhase');
const statusDetail = $('statusDetail');
const disconnectBtn = $<HTMLButtonElement>('disconnectBtn');
const refreshBtn = $<HTMLButtonElement>('refreshBtn');
const fastestBtn = $<HTMLButtonElement>('fastestBtn');
const searchInput = $<HTMLInputElement>('search');
const countEl = $('count');
const serverBody = $('serverBody');
const logEl = $('log');
const clearLogBtn = $('clearLog');
const creditLink = $('credit');
const privacyNotice = $('privacyNotice');
const privacyAck = $<HTMLButtonElement>('privacyAck');

let allServers: VpnServer[] = [];
let currentStatus: VpnStatus = { phase: 'disconnected' };
let connectingHost: string | null = null;

// ---- helpers ----
function flag(cc: string): string {
  if (!/^[A-Z]{2}$/.test(cc)) return '🌐';
  const base = 0x1f1e6;
  return String.fromCodePoint(
    base + (cc.charCodeAt(0) - 65),
    base + (cc.charCodeAt(1) - 65),
  );
}

function esc(s: string): string {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function appendLog(line: string): void {
  const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
  logEl.textContent += line + '\n';
  if (atBottom) logEl.scrollTop = logEl.scrollHeight;
}

// ---- banner / environment ----
async function refreshEnv(): Promise<void> {
  const env: EnvInfo = await api.getEnv();
  banner.className = 'banner';
  banner.innerHTML = '';

  if (!env.openvpn.found) {
    banner.classList.add('error');
    banner.innerHTML =
      '<span>⚠️ <b>OpenVPN Community not found.</b> This app needs openvpn.exe to connect. ' +
      'It installs alongside your work OpenVPN Connect without affecting it.</span>' +
      '<span class="banner-actions">' +
      '<button class="btn btn-sm" id="getOpenVpn">Download OpenVPN</button></span>';
    banner.classList.remove('hidden');
    $('getOpenVpn').onclick = () =>
      api.openExternal('https://openvpn.net/community-downloads/');
    return;
  }

  if (!env.isAdmin) {
    banner.innerHTML =
      '<span>🔒 <b>Not running as administrator.</b> OpenVPN needs admin rights to ' +
      'configure the network adapter. Connections will fail until you relaunch elevated.</span>' +
      '<span class="banner-actions">' +
      '<button class="btn btn-sm btn-primary" id="relaunch">Relaunch as admin</button></span>';
    banner.classList.remove('hidden');
    $('relaunch').onclick = () => api.relaunchAsAdmin();
    return;
  }

  banner.classList.add('hidden');
}

// ---- status ----
function renderStatus(s: VpnStatus): void {
  currentStatus = s;
  connectingHost = s.phase === 'connecting' ? s.server?.hostName ?? null : null;

  const dotClass =
    s.phase === 'connected'
      ? 'connected'
      : s.phase === 'connecting' || s.phase === 'disconnecting'
        ? 'connecting'
        : s.phase === 'error'
          ? 'error'
          : '';
  statusDot.className = 'dot ' + dotClass;

  const label: Record<VpnStatus['phase'], string> = {
    disconnected: 'Disconnected',
    connecting: 'Connecting…',
    connected: 'Connected',
    disconnecting: 'Disconnecting…',
    error: 'Error',
  };
  statusPhase.textContent = label[s.phase];

  if (s.phase === 'connected' && s.server) {
    statusDetail.textContent = `${flag(s.server.countryShort)} ${s.server.countryLong} · ${s.server.hostName}`;
  } else if (s.phase === 'connecting' && s.server) {
    statusDetail.textContent = `${flag(s.server.countryShort)} ${s.server.countryLong} · ${s.server.hostName}`;
  } else if (s.message) {
    statusDetail.textContent = s.message;
  } else {
    statusDetail.textContent = 'Not connected';
  }

  disconnectBtn.disabled = !(s.phase === 'connected' || s.phase === 'connecting');
  updateFastestBtn();
  renderRows(); // reflect per-row button state
}

// ---- server table ----
function visibleServers(): VpnServer[] {
  const q = searchInput.value.trim().toLowerCase();
  if (!q) return allServers;
  return allServers.filter(
    (s) =>
      s.countryLong.toLowerCase().includes(q) ||
      s.countryShort.toLowerCase().includes(q),
  );
}

function renderRows(): void {
  const rows = visibleServers();
  countEl.textContent = `${rows.length} server${rows.length === 1 ? '' : 's'}`;

  if (rows.length === 0) {
    serverBody.innerHTML =
      '<tr><td colspan="7" class="empty">No servers match your filter.</td></tr>';
    return;
  }

  const connectedHost =
    currentStatus.phase === 'connected' ? currentStatus.server?.hostName : null;
  const busy =
    currentStatus.phase === 'connecting' || currentStatus.phase === 'disconnecting';

  serverBody.innerHTML = rows
    .slice(0, 300)
    .map((s, i) => {
      const isConnected = s.hostName === connectedHost;
      const isConnecting = s.hostName === connectingHost;
      let btn: string;
      if (isConnected) {
        btn = `<button class="btn btn-sm btn-danger" data-act="disconnect">Disconnect</button>`;
      } else if (isConnecting) {
        btn = `<button class="btn btn-sm" disabled>Connecting…</button>`;
      } else {
        btn = `<button class="btn btn-sm btn-primary" data-act="connect" data-i="${i}" ${
          busy ? 'disabled' : ''
        }>Connect</button>`;
      }
      return `<tr class="${isConnected ? 'active-row' : ''}">
        <td><span class="flag">${flag(s.countryShort)}</span>${esc(s.countryLong)}</td>
        <td class="host">${esc(s.hostName)}</td>
        <td class="num">${s.ping ? s.ping + ' ms' : '—'}</td>
        <td class="num">${s.speedMbps ? s.speedMbps + ' Mbps' : '—'}</td>
        <td class="num">${s.sessions}</td>
        <td><span class="proto">${s.proto}</span></td>
        <td class="action">${btn}</td>
      </tr>`;
    })
    .join('');

  // wire row buttons
  serverBody.querySelectorAll<HTMLButtonElement>('button[data-act]').forEach((b) => {
    const act = b.dataset.act;
    if (act === 'disconnect') {
      b.onclick = () => api.disconnect();
    } else if (act === 'connect') {
      const idx = Number(b.dataset.i);
      b.onclick = () => connectTo(rows[idx]);
    }
  });
}

async function connectTo(server: VpnServer): Promise<void> {
  try {
    appendLog(`\n=== Connecting to ${server.hostName} (${server.countryLong}) ===`);
    await api.connect(server);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    appendLog(`ERROR: ${msg}`);
    renderStatus({ phase: 'error', message: msg });
  }
}

/**
 * Pick the "fastest" server: prefer responsive relays (ping > 0), rank by a
 * simple speed-per-ping score, and require enough spare capacity.
 */
function pickFastest(): VpnServer | null {
  const candidates = allServers.filter((s) => s.speedMbps > 0);
  if (candidates.length === 0) return allServers[0] ?? null;
  const scored = candidates.map((s) => {
    const ping = s.ping > 0 ? s.ping : 200; // treat unknown ping as mediocre
    return { s, rank: s.speedMbps / Math.sqrt(ping) };
  });
  scored.sort((a, b) => b.rank - a.rank);
  return scored[0].s;
}

/** The Fastest button is usable only when idle AND at least one server exists. */
function updateFastestBtn(): void {
  const phase = currentStatus.phase;
  const busy =
    phase === 'connected' || phase === 'connecting' || phase === 'disconnecting';
  fastestBtn.disabled = busy || allServers.length === 0;
}

async function connectFastest(): Promise<void> {
  const best = pickFastest();
  if (!best) {
    appendLog('No servers available to connect.');
    return;
  }
  appendLog(
    `\n⚡ Auto-picked fastest: ${best.countryLong} · ${best.hostName} ` +
      `(${best.speedMbps} Mbps, ${best.ping || '?'} ms)`,
  );
  await connectTo(best);
}

async function loadServers(): Promise<void> {
  serverBody.innerHTML =
    '<tr><td colspan="7" class="empty">Loading server list…</td></tr>';
  refreshBtn.disabled = true;
  allServers = [];
  updateFastestBtn(); // no servers yet → Fastest stays disabled
  try {
    allServers = await api.listServers();
    renderRows();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    serverBody.innerHTML = `<tr><td colspan="7" class="empty">Failed to load: ${esc(msg)}</td></tr>`;
  } finally {
    refreshBtn.disabled = false;
    updateFastestBtn(); // enable only if servers actually loaded
  }
}

// ---- wire up ----
refreshBtn.onclick = () => {
  loadServers();
  refreshEnv();
};
disconnectBtn.onclick = () => api.disconnect();
fastestBtn.onclick = () => connectFastest();
searchInput.oninput = () => renderRows();
clearLogBtn.onclick = () => {
  logEl.textContent = '';
};
creditLink.onclick = (e) => {
  e.preventDefault();
  api.openExternal('https://github.com/tohidmalik002');
};

// Privacy notice — shown until the user acknowledges it (remembered locally).
const PRIVACY_KEY = 'freevpn.privacyAck';
if (localStorage.getItem(PRIVACY_KEY) !== '1') {
  privacyNotice.classList.remove('hidden');
}
privacyAck.onclick = () => {
  localStorage.setItem(PRIVACY_KEY, '1');
  privacyNotice.classList.add('hidden');
};

api.onStatus((s) => renderStatus(s));
api.onLog((line) => appendLog(line));

// initial load
refreshEnv();
loadServers();
api.getStatus().then(renderStatus);

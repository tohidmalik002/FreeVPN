import type { AppEntry, EnvInfo, VpnServer, VpnStatus } from './global';

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
const splitToggle = $<HTMLInputElement>('splitTunnel');
const splitHint = $('splitHint');

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

  // Per-app routing engine readiness (shown in the chosen-apps hint).
  const engineStatus = document.getElementById('engineStatus');
  if (engineStatus) {
    if (env.proxifyre.found) {
      engineStatus.className = 'engine-status engine-ok';
      engineStatus.innerHTML = '✓ Per-app routing engine ready.';
    } else {
      engineStatus.className = 'engine-status engine-missing';
      engineStatus.innerHTML =
        '⚠️ Per-app routing needs a one-time setup (ProxiFyre + driver). Without it, chosen ' +
        'apps stay on your normal internet.' +
        '<div class="engine-actions">' +
        '<button id="runSetup" class="btn btn-sm btn-primary">Run automatic setup</button>' +
        '<a id="getProxifyre">Set up manually</a>' +
        '</div>';
      const setupBtn = document.getElementById('runSetup') as HTMLButtonElement | null;
      if (setupBtn) {
        setupBtn.onclick = () => {
          api.runSetup();
          appendLog(
            '\n[setup] Launched the automatic setup in a new window. Follow its prompts, ' +
              'then click ↻ Refresh here when it finishes.',
          );
        };
      }
      const link = document.getElementById('getProxifyre');
      if (link)
        link.onclick = () =>
          api.openExternal('https://github.com/wiresock/proxifyre#readme');
    }
  }

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
  handleFailover(s);

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
  updateLaunchButton();
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
      b.onclick = () => {
        failoverActive = false;
        api.disconnect();
      };
    } else if (act === 'connect') {
      const idx = Number(b.dataset.i);
      b.onclick = () => {
        failoverActive = false; // manual pick cancels any Quick Connect in progress
        connectTo(rows[idx]);
      };
    }
  });
}

async function connectTo(server: VpnServer): Promise<void> {
  try {
    const splitTunnel = splitToggle.checked;
    appendLog(
      `\n=== Connecting to ${server.hostName} (${server.countryLong})` +
        `${splitTunnel ? ' [VPN for chosen apps only]' : ''} ===`,
    );
    await api.connect(server, { splitTunnel });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    appendLog(`ERROR: ${msg}`);
    renderStatus({ phase: 'error', message: msg });
  }
}

/** Rank servers best-first by a simple speed-per-ping score. */
function rankedCandidates(): VpnServer[] {
  const candidates = allServers.filter((s) => s.speedMbps > 0);
  const scored = (candidates.length ? candidates : allServers).map((s) => {
    const ping = s.ping > 0 ? s.ping : 200; // treat unknown ping as mediocre
    return { s, rank: s.speedMbps / Math.sqrt(ping) };
  });
  scored.sort((a, b) => b.rank - a.rank);
  return scored.map((x) => x.s);
}

/** The Fastest button is usable only when idle AND at least one server exists. */
function updateFastestBtn(): void {
  const phase = currentStatus.phase;
  const busy =
    phase === 'connected' || phase === 'connecting' || phase === 'disconnecting';
  fastestBtn.disabled = busy || allServers.length === 0;
}

// Auto-failover: VPN Gate servers are often dead, so "Fastest" walks down the
// ranked list until one actually connects.
let failoverQueue: VpnServer[] = [];
let failoverActive = false;
let failoverAwaiting = false; // waiting on the current attempt's result
const FAILOVER_TRIES = 6;

async function connectFastest(): Promise<void> {
  const ranked = rankedCandidates();
  if (ranked.length === 0) {
    appendLog('No servers available to connect.');
    return;
  }
  failoverQueue = ranked.slice(0, FAILOVER_TRIES);
  failoverActive = true;
  appendLog(
    `\n⚡ Quick Connect — trying up to ${failoverQueue.length} fastest servers until one works…`,
  );
  connectNextCandidate();
}

function connectNextCandidate(): void {
  const next = failoverQueue.shift();
  if (!next) {
    failoverActive = false;
    appendLog('⚡ All candidates failed. Hit ↻ Refresh for a fresh server list and retry.');
    return;
  }
  failoverAwaiting = true;
  appendLog(
    `→ trying ${flag(next.countryShort)} ${next.countryLong} · ${next.hostName} ` +
      `(${next.speedMbps} Mbps, ${next.ping || '?'} ms)`,
  );
  connectTo(next);
}

/** During a Quick Connect, advance to the next server when one fails. */
function handleFailover(s: VpnStatus): void {
  if (!failoverActive) return;
  if (s.phase === 'connected') {
    failoverActive = false;
    failoverAwaiting = false;
  } else if (s.phase === 'error') {
    // Ignore duplicate error events for the same attempt.
    if (!failoverAwaiting) return;
    failoverAwaiting = false;
    setTimeout(connectNextCandidate, 400);
  }
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
disconnectBtn.onclick = () => {
  failoverActive = false;
  api.disconnect();
};
fastestBtn.onclick = () => connectFastest();
searchInput.oninput = () => renderRows();
clearLogBtn.onclick = () => {
  logEl.textContent = '';
};
creditLink.onclick = (e) => {
  e.preventDefault();
  api.openExternal('https://github.com/tohidmalik002');
};

// Plain-language hint when "VPN for chosen apps only" is enabled.
splitToggle.onchange = () => {
  splitHint.classList.toggle('hidden', !splitToggle.checked);
  if (splitToggle.checked) updateAppsSummary();
};

// ---- app picker ----
const chooseAppsBtn = $<HTMLButtonElement>('chooseAppsBtn');
const appsSummary = $('appsSummary');
const appModal = $('appModal');
const appModalClose = $('appModalClose');
const appCancel = $<HTMLButtonElement>('appCancel');
const appSave = $<HTMLButtonElement>('appSave');
const appSearch = $<HTMLInputElement>('appSearch');
const addByFile = $<HTMLButtonElement>('addByFile');
const appList = $('appList');
const appCount = $('appCount');

let knownApps: AppEntry[] = []; // running ∪ selected
let lastSelected: AppEntry[] = [];
const runningExes = new Set<string>();
const workingSel = new Map<string, AppEntry>(); // exe -> entry
const launchAppsBtn = $<HTMLButtonElement>('launchAppsBtn');

async function updateAppsSummary(): Promise<void> {
  const selected = await api.getSelectedApps();
  lastSelected = selected;
  if (selected.length === 0) {
    appsSummary.textContent = 'No apps chosen yet';
  } else {
    const names = selected.map((a) => a.name || a.exe);
    appsSummary.textContent =
      `${selected.length} app${selected.length === 1 ? '' : 's'}: ` +
      names.slice(0, 3).join(', ') +
      (names.length > 3 ? `, +${names.length - 3} more` : '');
  }
  updateLaunchButton();
}

// Linux has no way to transparently capture an already-running app's
// traffic (see linuxSplit.ts), so chosen apps are launched through the
// tunnel instead — this button only makes sense there, once split mode is
// actually connected and something is selected.
function updateLaunchButton(): void {
  const show =
    api.platform === 'linux' &&
    currentStatus.phase === 'connected' &&
    splitToggle.checked &&
    lastSelected.length > 0;
  launchAppsBtn.classList.toggle('hidden', !show);
}

launchAppsBtn.onclick = () => {
  for (const a of lastSelected) api.launchInTunnel(a.path || a.exe);
  appendLog(
    `\n[split] launching ${lastSelected.length} app(s) in the routed namespace…`,
  );
};

async function openAppModal(): Promise<void> {
  appModal.classList.remove('hidden');
  appList.innerHTML = '<div class="app-empty">Loading running apps…</div>';
  const [running, selected] = await Promise.all([
    api.listApps(),
    api.getSelectedApps(),
  ]);
  runningExes.clear();
  running.forEach((a) => runningExes.add(a.exe));

  workingSel.clear();
  selected.forEach((a) => workingSel.set(a.exe, a));

  // merge: running first, then any selected apps that aren't currently running
  const byExe = new Map<string, AppEntry>();
  running.forEach((a) => byExe.set(a.exe, a));
  selected.forEach((a) => {
    if (!byExe.has(a.exe)) byExe.set(a.exe, a);
  });
  knownApps = Array.from(byExe.values()).sort((a, b) =>
    (a.name || a.exe).localeCompare(b.name || b.exe),
  );

  appSearch.value = '';
  renderApps();
}

function renderApps(): void {
  const q = appSearch.value.trim().toLowerCase();
  const rows = knownApps.filter(
    (a) =>
      !q || a.name.toLowerCase().includes(q) || a.exe.toLowerCase().includes(q),
  );
  if (rows.length === 0) {
    appList.innerHTML = '<div class="app-empty">No matching apps.</div>';
  } else {
    appList.innerHTML = rows
      .map((a, i) => {
        const checked = workingSel.has(a.exe) ? 'checked' : '';
        const badge = runningExes.has(a.exe)
          ? ''
          : '<span class="not-running">not running</span>';
        return `<label class="app-row">
          <input type="checkbox" data-i="${i}" ${checked} />
          <div><div class="app-name">${esc(a.name)}</div>
          <div class="app-exe">${esc(a.exe)}</div></div>${badge}
        </label>`;
      })
      .join('');
    appList.querySelectorAll<HTMLInputElement>('input[type=checkbox]').forEach((cb) => {
      cb.onchange = () => {
        const app = rows[Number(cb.dataset.i)];
        if (cb.checked) workingSel.set(app.exe, app);
        else workingSel.delete(app.exe);
        updateModalCount();
      };
    });
  }
  updateModalCount();
}

function updateModalCount(): void {
  const n = workingSel.size;
  appCount.textContent = `${n} app${n === 1 ? '' : 's'} selected`;
}

function closeAppModal(): void {
  appModal.classList.add('hidden');
}

chooseAppsBtn.onclick = () => openAppModal();
appModalClose.onclick = () => closeAppModal();
appCancel.onclick = () => closeAppModal();
appModal.onclick = (e) => {
  if (e.target === appModal) closeAppModal();
};
appSearch.oninput = () => renderApps();
appSave.onclick = async () => {
  await api.setSelectedApps(Array.from(workingSel.values()));
  await updateAppsSummary();
  closeAppModal();
};
addByFile.onclick = async () => {
  const picked = await api.browseForApp();
  if (!picked) return;
  if (!knownApps.some((a) => a.exe === picked.exe)) {
    knownApps.push(picked);
    knownApps.sort((a, b) => (a.name || a.exe).localeCompare(b.name || b.exe));
  }
  workingSel.set(picked.exe, picked);
  renderApps();
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
updateAppsSummary();
api.getStatus().then(renderStatus);

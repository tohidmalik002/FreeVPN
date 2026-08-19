import { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage, dialog } from 'electron';
import { spawn, exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fetchServers } from './vpngate';
import { OpenVpnManager, locateOpenVpn, isAdmin } from './openvpn';
import { shieldPng } from './icon';
import {
  listRunningApps,
  loadSelectedApps,
  saveSelectedApps,
  AppEntry,
} from './apps';
import { SplitProxy } from './splitProxy';
import { ProxifyreManager, locateProxifyre } from './proxifyre';
import { EnvInfo, VpnPhase, VpnServer, VpnStatus } from '../shared/types';

const SPLIT_PROXY_PORT = 1080;

// Project root (…/FreeVPN), whether running from source or packaged.
const APP_ROOT = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', '..');

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let lastStatus: VpnStatus = { phase: 'disconnected' };
const vpn = new OpenVpnManager();

// --- per-app split tunnelling (only ever active when the user opts in) ---
const splitProxy = new SplitProxy((line) => win?.webContents.send('vpn:log', line));
const proxifyre = new ProxifyreManager();
let splitRequested = false; // did the last connect ask for chosen-apps mode?
let splitExes: string[] = []; // the chosen executables at connect time

async function startSplitRouting(): Promise<void> {
  // Guard: only run when the user chose split mode AND picked apps AND the
  // engine is installed. Any failure here must NOT affect the VPN connection.
  if (!splitRequested || splitExes.length === 0) return;
  const pf = locateProxifyre(APP_ROOT);
  if (!pf.found || !pf.path) {
    win?.webContents.send(
      'vpn:log',
      '[split] per-app routing skipped — ProxiFyre not installed (connection is up as normal).',
    );
    return;
  }
  try {
    await splitProxy.start(SPLIT_PROXY_PORT);
    proxifyre.start(pf.path, splitExes, SPLIT_PROXY_PORT, (l) =>
      win?.webContents.send('vpn:log', l),
    );
    win?.webContents.send(
      'vpn:log',
      `[split] per-app routing active for: ${splitExes.join(', ')}`,
    );
  } catch (e) {
    win?.webContents.send(
      'vpn:log',
      `[split] could not start per-app routing: ${e instanceof Error ? e.message : e}`,
    );
    await stopSplitRouting();
  }
}

async function stopSplitRouting(): Promise<void> {
  proxifyre.stop();
  await splitProxy.stop().catch(() => undefined);
}

// Tray/app icon colour per connection phase.
const PHASE_COLOR: Record<VpnPhase, string> = {
  disconnected: '#8a97b0',
  connecting: '#fbbf24',
  connected: '#34d399',
  disconnecting: '#fbbf24',
  error: '#f87171',
};

function iconFor(phase: VpnPhase, size: number) {
  return nativeImage.createFromBuffer(shieldPng(PHASE_COLOR[phase], size));
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 820,
    minHeight: 560,
    backgroundColor: '#0f1420',
    title: 'FreeVPN',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.removeMenu();
  win.setIcon(iconFor('disconnected', 256));
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Minimize button → hide to the tray (VPN keeps running; tray shows state).
  win.on('minimize', () => {
    win?.hide();
  });

  // Closing the window (✕) disconnects and quits — no invisible-VPN surprise.
  win.on('close', () => {
    isQuitting = true;
  });

  win.on('closed', () => {
    win = null;
  });
}

function showWindow(): void {
  if (!win) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function buildTrayMenu(): Menu {
  const s = lastStatus;
  const connected = s.phase === 'connected';
  const connecting = s.phase === 'connecting' || s.phase === 'disconnecting';
  const label =
    connected && s.server
      ? `Connected · ${s.server.countryLong}`
      : connecting
        ? 'Connecting…'
        : s.phase === 'error'
          ? 'Error'
          : 'Disconnected';
  return Menu.buildFromTemplate([
    { label: `FreeVPN — ${label}`, enabled: false },
    { type: 'separator' },
    { label: 'Open FreeVPN', click: () => showWindow() },
    {
      label: 'Disconnect',
      enabled: connected || connecting,
      click: () => vpn.disconnect().catch(() => undefined),
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
}

function createTray(): void {
  tray = new Tray(iconFor('disconnected', 16));
  tray.setToolTip('FreeVPN — Disconnected');
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', () => showWindow());
  tray.on('double-click', () => showWindow());
}

function updateTray(s: VpnStatus): void {
  if (!tray) return;
  tray.setImage(iconFor(s.phase, 16));
  const detail =
    s.phase === 'connected' && s.server
      ? `Connected · ${s.server.countryLong}`
      : s.phase.charAt(0).toUpperCase() + s.phase.slice(1);
  tray.setToolTip(`FreeVPN — ${detail}`);
  tray.setContextMenu(buildTrayMenu());
}

/** Relaunch the app elevated (UAC prompt), then quit the current instance. */
function relaunchAsAdmin(): void {
  const exe = process.execPath; // electron.exe (dev) or FreeVPN.exe (packaged)
  const args = app.isPackaged ? [] : process.argv.slice(1); // pass the app dir in dev
  const argList = args.map((a) => `'${a.replace(/'/g, "''")}'`).join(',');
  const psCmd =
    argList.length > 0
      ? `Start-Process -FilePath '${exe}' -ArgumentList ${argList} -Verb RunAs`
      : `Start-Process -FilePath '${exe}' -Verb RunAs`;
  spawn('powershell.exe', ['-NoProfile', '-Command', psCmd], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  }).unref();
  app.quit();
}

function registerIpc(): void {
  ipcMain.handle('env:info', async (): Promise<EnvInfo> => {
    return {
      isAdmin: await isAdmin(),
      openvpn: locateOpenVpn(APP_ROOT),
      proxifyre: locateProxifyre(APP_ROOT),
    };
  });

  ipcMain.handle('vpn:list', async (): Promise<VpnServer[]> => {
    return fetchServers();
  });

  ipcMain.handle(
    'vpn:connect',
    async (_e, server: VpnServer, opts?: { splitTunnel?: boolean }): Promise<void> => {
      const info = locateOpenVpn(APP_ROOT);
      if (!info.found || !info.path) {
        throw new Error(
          'openvpn.exe not found. Install OpenVPN Community from openvpn.net/community.',
        );
      }
      // Remember whether this connection wants per-app routing (and for which apps).
      splitRequested = !!opts?.splitTunnel;
      splitExes = splitRequested ? loadSelectedApps().map((a) => a.exe) : [];
      await vpn.connect(server, info.path, opts ?? {});
    },
  );

  ipcMain.handle('vpn:disconnect', async (): Promise<void> => {
    await vpn.disconnect();
  });

  ipcMain.handle('vpn:status', () => vpn.getStatus());

  ipcMain.handle('apps:list', () => listRunningApps());
  ipcMain.handle('apps:getSelected', () => loadSelectedApps());
  ipcMain.handle('apps:setSelected', (_e, apps: AppEntry[]) => saveSelectedApps(apps));

  ipcMain.handle('apps:browse', async (): Promise<AppEntry | null> => {
    const res = await dialog.showOpenDialog({
      title: 'Choose an app (.exe) to route through the VPN',
      properties: ['openFile'],
      filters: [{ name: 'Applications', extensions: ['exe'] }],
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    const p = res.filePaths[0];
    const exe = path.basename(p).toLowerCase();
    const name = path.basename(p, path.extname(p));
    return { name, exe, path: p };
  });

  ipcMain.handle('app:relaunch-admin', () => relaunchAsAdmin());

  ipcMain.handle('app:run-setup', () => {
    // Launch the per-app setup script in its OWN console window so the user sees
    // progress. A GUI process has no console, so a detached powershell child gets
    // no visible window — `start` forces cmd to allocate a new console window.
    // The app already runs elevated, so the child inherits admin.
    const ps1 = path.join(APP_ROOT, 'scripts', 'setup-perapp.ps1');
    if (!fs.existsSync(ps1)) {
      win?.webContents.send('vpn:log', `[setup] script not found at ${ps1}`);
      return;
    }
    const cmd =
      `start "FreeVPN Setup" powershell -NoProfile -NoExit ` +
      `-ExecutionPolicy Bypass -File "${ps1}"`;
    exec(cmd, { windowsHide: true }, (err) => {
      if (err) {
        win?.webContents.send('vpn:log', `[setup] failed to launch: ${err.message}`);
      }
    });
  });

  ipcMain.handle('app:open-external', (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });
}

// Running elevated makes Chromium's shader disk-cache noisy (access-denied on
// the cache dir); the cache is a perf nicety, so disable it to keep logs clean.
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');

// Single-instance: a second launch just focuses the existing window instead of
// spawning a competing process that would fight over the disk cache.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}
app.on('second-instance', () => showWindow());

app.whenReady().then(() => {
  if (!gotSingleInstanceLock) return;
  registerIpc();

  // Single source of truth for status → renderer + tray + window icon.
  vpn.on('status', (s: VpnStatus) => {
    lastStatus = s;
    win?.webContents.send('vpn:status', s);
    win?.setIcon(iconFor(s.phase, 256));
    updateTray(s);

    // Drive per-app routing off the connection lifecycle (opt-in only).
    if (s.phase === 'connected') {
      startSplitRouting().catch(() => undefined);
    } else if (s.phase === 'disconnected' || s.phase === 'error') {
      stopSplitRouting().catch(() => undefined);
    }
  });
  vpn.on('log', (line: string) => win?.webContents.send('vpn:log', line));

  createTray();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showWindow();
  });
});

// Closing the window quits the app (and before-quit tears down the tunnel).
// Minimize-to-tray uses hide(), which does NOT fire window-all-closed, so the
// app still lives in the tray while minimized.
app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', async () => {
  isQuitting = true;
  await stopSplitRouting().catch(() => undefined);
  await vpn.disconnect().catch(() => undefined);
});

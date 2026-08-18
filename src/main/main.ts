import { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage } from 'electron';
import { spawn } from 'child_process';
import * as path from 'path';
import { fetchServers } from './vpngate';
import { OpenVpnManager, locateOpenVpn, isAdmin } from './openvpn';
import { shieldPng } from './icon';
import { EnvInfo, VpnPhase, VpnServer, VpnStatus } from '../shared/types';

// Project root (…/FreeVPN), whether running from source or packaged.
const APP_ROOT = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', '..');

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let lastStatus: VpnStatus = { phase: 'disconnected' };
const vpn = new OpenVpnManager();

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

  // Minimize-to-tray: closing the window hides it instead of quitting.
  win.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      win?.hide();
    }
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
    };
  });

  ipcMain.handle('vpn:list', async (): Promise<VpnServer[]> => {
    return fetchServers();
  });

  ipcMain.handle('vpn:connect', async (_e, server: VpnServer): Promise<void> => {
    const info = locateOpenVpn(APP_ROOT);
    if (!info.found || !info.path) {
      throw new Error(
        'openvpn.exe not found. Install OpenVPN Community from openvpn.net/community.',
      );
    }
    await vpn.connect(server, info.path);
  });

  ipcMain.handle('vpn:disconnect', async (): Promise<void> => {
    await vpn.disconnect();
  });

  ipcMain.handle('vpn:status', () => vpn.getStatus());

  ipcMain.handle('app:relaunch-admin', () => relaunchAsAdmin());

  ipcMain.handle('app:open-external', (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });
}

app.whenReady().then(() => {
  registerIpc();

  // Single source of truth for status → renderer + tray + window icon.
  vpn.on('status', (s: VpnStatus) => {
    lastStatus = s;
    win?.webContents.send('vpn:status', s);
    win?.setIcon(iconFor(s.phase, 256));
    updateTray(s);
  });
  vpn.on('log', (line: string) => win?.webContents.send('vpn:log', line));

  createTray();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showWindow();
  });
});

// Minimize-to-tray means we do NOT quit when the window closes; the app keeps
// running in the tray. Quit happens via the tray menu or before-quit.
app.on('window-all-closed', () => {
  // no-op on Windows: stay alive in the tray
});

app.on('before-quit', async () => {
  isQuitting = true;
  await vpn.disconnect().catch(() => undefined);
});

import { contextBridge, ipcRenderer } from 'electron';
import { EnvInfo, VpnServer, VpnStatus } from '../shared/types';

interface AppEntry {
  name: string;
  exe: string;
  path?: string;
}

// The typed API surface exposed to the renderer as `window.api`.
const api = {
  getEnv: (): Promise<EnvInfo> => ipcRenderer.invoke('env:info'),
  listServers: (): Promise<VpnServer[]> => ipcRenderer.invoke('vpn:list'),
  connect: (server: VpnServer, opts?: { splitTunnel?: boolean }): Promise<void> =>
    ipcRenderer.invoke('vpn:connect', server, opts),
  disconnect: (): Promise<void> => ipcRenderer.invoke('vpn:disconnect'),
  getStatus: (): Promise<VpnStatus> => ipcRenderer.invoke('vpn:status'),
  relaunchAsAdmin: (): Promise<void> => ipcRenderer.invoke('app:relaunch-admin'),
  openExternal: (url: string): Promise<void> =>
    ipcRenderer.invoke('app:open-external', url),

  // per-app selection
  listApps: (): Promise<AppEntry[]> => ipcRenderer.invoke('apps:list'),
  getSelectedApps: (): Promise<AppEntry[]> => ipcRenderer.invoke('apps:getSelected'),
  setSelectedApps: (apps: AppEntry[]): Promise<void> =>
    ipcRenderer.invoke('apps:setSelected', apps),
  browseForApp: (): Promise<AppEntry | null> => ipcRenderer.invoke('apps:browse'),

  onStatus: (cb: (s: VpnStatus) => void): void => {
    ipcRenderer.on('vpn:status', (_e, s: VpnStatus) => cb(s));
  },
  onLog: (cb: (line: string) => void): void => {
    ipcRenderer.on('vpn:log', (_e, line: string) => cb(line));
  },
};

export type FreeVpnApi = typeof api;
contextBridge.exposeInMainWorld('api', api);

// Renderer-local mirror of the shared types (the renderer is built in isolation
// with rootDir=src/renderer, so it can't import from ../shared).

export interface VpnServer {
  hostName: string;
  ip: string;
  countryLong: string;
  countryShort: string;
  ping: number;
  speedMbps: number;
  sessions: number;
  uptimeHours: number;
  score: number;
  proto: 'tcp' | 'udp' | 'unknown';
  configBase64: string;
}

export type VpnPhase =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'disconnecting'
  | 'error';

export interface VpnStatus {
  phase: VpnPhase;
  server?: { hostName: string; countryLong: string; countryShort: string };
  message?: string;
  since?: number;
}

export interface OpenVpnInfo {
  found: boolean;
  path?: string;
  source?: 'bundled' | 'community' | 'community-x86';
}

export interface EnvInfo {
  isAdmin: boolean;
  openvpn: OpenVpnInfo;
}

export interface AppEntry {
  name: string;
  exe: string;
  path?: string;
}

declare global {
  interface Window {
    api: {
      getEnv(): Promise<EnvInfo>;
      listServers(): Promise<VpnServer[]>;
      connect(server: VpnServer, opts?: { splitTunnel?: boolean }): Promise<void>;
      disconnect(): Promise<void>;
      getStatus(): Promise<VpnStatus>;
      relaunchAsAdmin(): Promise<void>;
      openExternal(url: string): Promise<void>;
      listApps(): Promise<AppEntry[]>;
      getSelectedApps(): Promise<AppEntry[]>;
      setSelectedApps(apps: AppEntry[]): Promise<void>;
      browseForApp(): Promise<AppEntry | null>;
      onStatus(cb: (s: VpnStatus) => void): void;
      onLog(cb: (line: string) => void): void;
    };
  }
}

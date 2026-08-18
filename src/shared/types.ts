// Types shared between the Electron main process and the preload bridge.

/** A single VPN Gate relay server, parsed from the public CSV API. */
export interface VpnServer {
  hostName: string;
  ip: string;
  countryLong: string;
  countryShort: string; // ISO 3166-1 alpha-2, e.g. "JP"
  ping: number; // ms (0 = unknown)
  speedMbps: number; // derived from bits/s
  sessions: number; // active VPN sessions
  uptimeHours: number;
  score: number; // VPN Gate quality score
  proto: 'tcp' | 'udp' | 'unknown';
  configBase64: string; // base64-encoded .ovpn file
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
  since?: number; // epoch ms when the phase started
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

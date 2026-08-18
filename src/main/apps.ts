// Running-app enumeration + persistence of the user's chosen apps.
//
// "Choosing an app" for per-app VPN ultimately means choosing an EXECUTABLE
// name (chrome.exe), because the packet-filter layer (ProxiFyre, Stage 1b)
// matches by image name. This module lists windowed apps and remembers the
// user's selection; wiring it to ProxiFyre comes in Stage 1b.
import { app } from 'electron';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface AppEntry {
  name: string; // friendly name, e.g. "Google Chrome"
  exe: string; // executable, e.g. "chrome.exe" (lowercased)
  path?: string; // full path if known
}

function psJson<T>(command: string): Promise<T> {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', command],
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err || !stdout.trim()) return resolve([] as unknown as T);
        try {
          const parsed = JSON.parse(stdout);
          resolve(parsed as T);
        } catch {
          resolve([] as unknown as T);
        }
      },
    );
  });
}

// Windows shell/system processes that have a window but aren't user apps.
const SYSTEM_EXES = new Set(
  [
    'applicationframehost.exe',
    'textinputhost.exe',
    'systemsettings.exe',
    'explorer.exe',
    'searchhost.exe',
    'startmenuexperiencehost.exe',
    'shellexperiencehost.exe',
    'lockapp.exe',
    'dwm.exe',
    'sihost.exe',
    'ctfmon.exe',
  ].map((s) => s.toLowerCase()),
);

/** List currently-running windowed apps (deduped by executable path). */
export async function listRunningApps(): Promise<AppEntry[]> {
  const script = `
    Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.Path } |
      Select-Object -ExpandProperty Path -Unique | ForEach-Object {
        $p = $_
        $desc = (Get-Item $p -ErrorAction SilentlyContinue).VersionInfo.FileDescription
        $name = $(if ($desc) { $desc } else { [System.IO.Path]::GetFileNameWithoutExtension($p) })
        [PSCustomObject]@{ name = $name; exe = (Split-Path $p -Leaf); path = $p }
      } | ConvertTo-Json -Compress`;
  let rows = await psJson<AppEntry[] | AppEntry>(script);
  if (!Array.isArray(rows)) rows = rows ? [rows] : [];
  const seen = new Set<string>();
  const out: AppEntry[] = [];
  for (const r of rows) {
    const exe = (r.exe || '').toLowerCase();
    if (!exe || seen.has(exe) || SYSTEM_EXES.has(exe)) continue;
    seen.add(exe);
    out.push({ name: r.name || exe, exe, path: r.path });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// ---- selection persistence ----
function selectionFile(): string {
  return path.join(app.getPath('userData'), 'selected-apps.json');
}

export function loadSelectedApps(): AppEntry[] {
  try {
    const raw = fs.readFileSync(selectionFile(), 'utf8');
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return arr.filter((a) => a && a.exe);
  } catch {
    /* none yet */
  }
  return [];
}

export function saveSelectedApps(apps: AppEntry[]): void {
  const clean = apps
    .filter((a) => a && a.exe)
    .map((a) => ({ name: a.name || a.exe, exe: a.exe.toLowerCase(), path: a.path }));
  fs.writeFileSync(selectionFile(), JSON.stringify(clean, null, 2), 'utf8');
}

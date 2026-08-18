# 🛡️ FreeVPN

A small **Windows desktop app** that lists free public [VPN Gate](https://www.vpngate.net/)
relay servers worldwide and connects to them with one click, using **OpenVPN** under the hood.

Built with **Electron + TypeScript**. No accounts, no tracking, no bundled ads.

---

## Table of contents

- [What it is](#what-it-is)
- [Features](#features)
- [Screenshots](#screenshots)
- [Privacy warning](#-privacy-warning)
- [Prerequisites](#prerequisites)
- [Run from source](#run-from-source)
- [Build a Windows installer](#build-a-windows-installer)
- [How it works](#how-it-works)
- [Project structure](#project-structure)
- [Troubleshooting](#troubleshooting)
- [Roadmap](#roadmap)
- [License](#license)

---

## What it is

[**VPN Gate**](https://www.vpngate.net/) is a free, volunteer-run academic VPN network from
the University of Tsukuba, Japan. Its public API returns hundreds of relay servers around the
world, each carrying a ready-to-use OpenVPN configuration.

FreeVPN fetches that list, shows it in a clean table, and connects to any server through the
**OpenVPN Community** engine (`openvpn.exe`). It is completely separate from the enterprise
**OpenVPN Connect** client you might have installed for work — FreeVPN never reads or touches
Connect's profiles.

## Features

| Feature | Description |
|---|---|
| **Live server list** | Country + flag, ping, speed, active sessions, protocol. Sorted best-first, filterable by country. |
| **⚡ Fastest** | One click auto-picks the best relay (ranked by `speed ÷ √ping`) and connects. |
| **One-click connect** | Decodes the server's `.ovpn` and drives `openvpn.exe`, watching for `Initialization Sequence Completed`. |
| **System tray** | A shield icon that changes colour with the connection state (grey → amber → green → red). Close = minimize to tray. |
| **Live connection log** | Raw OpenVPN output streamed into a panel at the bottom. |
| **Admin-aware** | Detects missing OpenVPN / missing admin rights and shows in-app fix buttons. |
| **Installer** | NSIS installer that self-elevates and creates shortcuts. |

## Screenshots

> _(Add a screenshot of the running app here — `docs/screenshot.png`.)_

The tray icon reflects state at a glance:

| State | Colour |
|---|---|
| Disconnected | ⚪ grey |
| Connecting / Disconnecting | 🟡 amber (pulsing dot in-app) |
| Connected | 🟢 green |
| Error | 🔴 red |

## ⚠️ Privacy warning

VPN Gate relays are run by **volunteers**. They're great for a quick foreign IP or bypassing
geo-blocks, but **you are routing traffic through a stranger's machine**.

- **Don't** use it for banking, sensitive logins, or anything private.
- Stick to **HTTPS** sites.
- For real privacy, self-host **WireGuard** on a VPS you control, or use an audited paid
  provider.

## Prerequisites

1. **OpenVPN Community** — provides `openvpn.exe` plus the network driver (Wintun/TAP).
   Download from <https://openvpn.net/community-downloads/> and install with defaults.
   It coexists with OpenVPN Connect. FreeVPN auto-detects it at
   `C:\Program Files\OpenVPN\bin\openvpn.exe`.
   _(Alternatively, drop a portable `openvpn.exe` into `vendor/openvpn/` to make FreeVPN
   fully standalone — it checks there first.)_
2. **Node.js 18+** — to build/run from source.
3. **Administrator rights** — OpenVPN needs them to configure the VPN adapter.

## Run from source

```bash
npm install
npm start          # builds, then launches Electron
```

Because the VPN adapter needs admin rights, do **one** of:

- **Double-click `Run FreeVPN (Admin).cmd`** — it self-elevates via a UAC prompt, then builds
  and launches the app; **or**
- launch an **Administrator** terminal and run `npm start`; **or**
- click **"Relaunch as admin"** in the app when it warns you.

## Build a Windows installer

```bash
npm run dist:win
```

Produces **`release/FreeVPN Setup <version>.exe`** — an NSIS installer that:

- lets you choose the install location,
- creates Start-menu + desktop shortcuts,
- and **requests administrator rights automatically at launch** (via the app manifest), so no
  separate elevation step is needed once installed.

The app icon is generated from `src/main/icon.ts` (a dependency-free shield renderer) into
`build/icon.ico` as part of the build.

## How it works

On **Connect**, the app decodes the selected server's base64 `.ovpn` into a temp file and runs:

```
openvpn --config server.ovpn \
        --data-ciphers AES-256-GCM:AES-128-GCM:AES-128-CBC:AES-256-CBC \
        --data-ciphers-fallback AES-128-CBC \
        --connect-timeout 15 --connect-retry-max 2
```

The cipher flags are needed because many VPN Gate configs still specify legacy ciphers that
OpenVPN 2.6 rejects by default. The app parses `openvpn`'s stdout:

- `Initialization Sequence Completed` → **Connected**
- `AUTH_FAILED`, adapter errors, non-zero exit → **Error** (surfaced in the UI + log)

**Disconnect** sends `SIGTERM` so OpenVPN tears the adapter and routes down cleanly (falling
back to `SIGKILL` after 4 s).

The renderer talks to the privileged main process only through a locked-down
`contextBridge` API (`window.api`) — `contextIsolation` on, `nodeIntegration` off, and a
strict CSP in `index.html`.

## Project structure

```
FreeVPN/
├─ src/
│  ├─ main/                 # Electron main process (Node, privileged)
│  │  ├─ main.ts            # window, tray, IPC, admin relaunch, lifecycle
│  │  ├─ vpngate.ts         # fetch + parse the VPN Gate CSV API
│  │  ├─ openvpn.ts         # locate/spawn openvpn.exe, parse status
│  │  └─ icon.ts            # dependency-free shield PNG/ICO generator
│  ├─ preload/
│  │  └─ preload.ts         # secure window.api bridge (contextBridge)
│  ├─ renderer/             # UI (sandboxed browser context)
│  │  ├─ index.html
│  │  ├─ styles.css
│  │  ├─ renderer.ts        # table, status, fastest-pick, logs
│  │  └─ global.d.ts        # renderer-local types + window.api typing
│  └─ shared/
│     └─ types.ts           # types shared by main + preload
├─ scripts/
│  ├─ copy-assets.js        # copies html/css into dist/
│  └─ gen-icon.js           # writes build/icon.{png,ico}
├─ Run FreeVPN (Admin).cmd  # self-elevating dev launcher
├─ tsconfig.json            # main + preload build (CommonJS)
├─ tsconfig.renderer.json   # renderer build (ES modules)
└─ package.json             # scripts + electron-builder config
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| Banner: *"OpenVPN Community not found"* | Install it from openvpn.net (button in the banner). Or drop `openvpn.exe` in `vendor/openvpn/`. |
| Banner: *"Not running as administrator"* | Click **Relaunch as admin**, or use `Run FreeVPN (Admin).cmd`. |
| Connects then immediately drops | The relay is overloaded/dead — pick another, or hit **⚡ Fastest**. VPN Gate servers churn constantly. |
| *"No VPN network adapter found"* | The OpenVPN Community install didn't add the TAP/Wintun driver — reinstall it with defaults. |
| Server list won't load | VPN Gate's site is occasionally slow or down; hit **↻ Refresh**. The fetcher tries two mirrors with a 20 s timeout each. |

## Roadmap

- Bundle a portable `openvpn.exe` + `wintun.dll` in `vendor/openvpn/` → zero external install.
- Favourites + auto-reconnect on drop.
- "Connect fastest" from the tray menu (needs the server list in the main process).
- Per-country quick filters and a speed-test on connect.

## License

**GPL-2.0** — OpenVPN and the ics-openvpn lineage this builds on are GPL. See [LICENSE](LICENSE).

VPN Gate is a service of the University of Tsukuba; this project is an independent client and
is not affiliated with or endorsed by VPN Gate or OpenVPN Inc.

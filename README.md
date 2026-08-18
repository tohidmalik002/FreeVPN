# 🛡️ FreeVPN

A small **Windows desktop app** that lists free public [VPN Gate](https://www.vpngate.net/)
relay servers worldwide and connects to them with one click, using **OpenVPN** under the hood.

Built with **Electron + TypeScript**. No accounts, no tracking, no bundled ads.

Made by [**@tohidmalik002**](https://github.com/tohidmalik002) · License: GPL-2.0 · Platform: Windows 10/11

---

## Table of contents

- [What it is](#what-it-is)
- [Features](#features)
- [Screenshots](#screenshots)
- [Privacy warning](#-privacy-warning)
- [Install](#install)
- [Run from source](#run-from-source)
- [Development](#development)
- [Build a Windows installer](#build-a-windows-installer)
- [How it works](#how-it-works)
- [Project structure](#project-structure)
- [Troubleshooting](#troubleshooting)
- [Roadmap](#roadmap)
- [Author](#author)
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

## Install

You need **two** things: **OpenVPN** (the engine that does the actual connecting) and
**FreeVPN** (this app, which finds servers and drives OpenVPN).

### 1. Install OpenVPN Community (required)

Download and run the installer from <https://openvpn.net/community-downloads/>, and **keep all
the default options**. That's it — the default install already includes everything FreeVPN
needs. It installs side-by-side with "OpenVPN Connect" and won't affect your work setup.

### 2. Get FreeVPN — pick one

**Option A — Download the ready-made build (easiest):**

Go to the [**Releases**](https://github.com/tohidmalik002/FreeVPN/releases) page and grab one:

- **`FreeVPN Setup <version>.exe`** — the **installer**. Run it, it self-elevates and creates
  Start-menu + desktop shortcuts.
- **`FreeVPN-<version>-win.zip`** — the **portable** build. Extract the folder anywhere and run
  **`FreeVPN.exe`** inside it (it self-elevates for admin). No install needed.

Either way you still need OpenVPN Community from step 1.

> **Antivirus / SmartScreen note:** the builds are **not code-signed** (a signing certificate
> costs money), so Windows may warn "unknown publisher," or an antivirus may flag a download.
> This is a false positive. If SmartScreen appears, click **More info → Run anyway**. The ZIP
> build is provided precisely because the older self-extracting "portable .exe" format trips
> more antivirus heuristics than a plain extracted `FreeVPN.exe`.

**Option B — Build from source:**

_Prerequisites:_

- **Node.js 18+** and npm — <https://nodejs.org/>
- **Windows 10/11**
- **Git** (or download the repo as a ZIP)

```bash
git clone https://github.com/tohidmalik002/FreeVPN.git
cd FreeVPN
npm install
npm start          # builds, then launches Electron
```

> **Note:** FreeVPN must run **as administrator** (OpenVPN needs it to set up the connection).
> The installed build handles this for you. From source, use `Run FreeVPN (Admin).cmd` or the
> in-app "Relaunch as admin" button — see below.

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

### Helper launchers

| File | Purpose |
|---|---|
| `Run FreeVPN (Admin).cmd` | Self-elevates (UAC) and starts the app. |
| `Disconnect VPN (Admin).cmd` | Emergency kill-switch — force-stops the `openvpn.exe` tunnel. Handy if the tray/app is unresponsive. Only affects FreeVPN's tunnel, never OpenVPN Connect. |

### Closing vs. minimizing

- **✕ (close)** disconnects the VPN and quits.
- **Minimize** hides the app to the system tray with the tunnel still up; the tray icon shows
  the state and its right-click menu has **Disconnect** / **Quit**.

## Development

Clone and install:

```bash
git clone https://github.com/tohidmalik002/FreeVPN.git
cd FreeVPN
npm install
```

### npm scripts

| Script | What it does |
|---|---|
| `npm run build` | Compiles both TypeScript projects and copies HTML/CSS into `dist/`. |
| `npm start` / `npm run dev` | `build`, then launches Electron. |
| `npm run icon` | Regenerates `build/icon.{png,ico}` from `src/main/icon.ts`. |
| `npm run dist:win` | `build` + `icon` + `electron-builder --win` → NSIS installer in `release/`. |
| `npm run clean` | Deletes `dist/`. |

### Build layout

There are **two** TypeScript configs on purpose:

- `tsconfig.json` → **main + preload**, emitted as **CommonJS** (Electron's Node side).
- `tsconfig.renderer.json` → **renderer**, emitted as **ES modules** for the browser context.

The renderer is deliberately isolated (`rootDir: src/renderer`) and can't import from
`src/shared`, so it keeps a local type mirror in `src/renderer/global.d.ts`. Static assets
(`index.html`, `styles.css`) are copied by `scripts/copy-assets.js`.

### Requirements

- **Node.js 18+** and npm.
- **Windows 10/11** (the app spawns `openvpn.exe` and uses Windows-only elevation).
- For actually connecting: **OpenVPN Community** installed (see [Install](#install)),
  and the app running **as administrator**.

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

## Author

Made by [**@tohidmalik002**](https://github.com/tohidmalik002).

Issues and pull requests welcome at
[github.com/tohidmalik002/FreeVPN](https://github.com/tohidmalik002/FreeVPN).

## License

**GPL-2.0** — OpenVPN and the ics-openvpn lineage this builds on are GPL. See [LICENSE](LICENSE).

VPN Gate is a service of the University of Tsukuba; this project is an independent client and
is not affiliated with or endorsed by VPN Gate or OpenVPN Inc.

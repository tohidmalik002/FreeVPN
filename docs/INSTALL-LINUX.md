# Installing FreeVPN on Linux (Ubuntu / Linux Mint)

## Install

```bash
sudo apt install ./freevpn_0.2.0_amd64.deb
```

Using `apt install` (not `dpkg -i`) matters here — it resolves and installs
the package's dependencies (`openvpn`, `policykit-1`, `iproute2`, `iptables`)
automatically if you don't already have them, in one step with no follow-up
`--fix-broken install` needed.

Launch **FreeVPN** from your applications menu, or from a terminal:

```bash
freevpn
```

## Why it asks for your password

FreeVPN does **not** run as root. When you click Connect, it elevates only
the `openvpn` process itself via `pkexec` (your desktop's normal
authentication dialog) — creating a tun device and changing routes needs
root, but the rest of the app doesn't. Disconnecting doesn't need another
prompt; it asks the elevated `openvpn` process to shut down over its own
local control channel. The installed polkit policy caches that
authorization for a few minutes, so retrying a failed server (e.g. via
"Fastest") or reconnecting shortly after doesn't re-prompt every time.

## Uninstall

```bash
sudo apt remove freevpn
```

## Troubleshooting

- **"openvpn not found"** — install it manually: `sudo apt install openvpn`.
- **Nothing happens when you click Connect / no password prompt appears** —
  make sure a polkit authentication agent is running (Mint's Cinnamon/MATE
  desktops start one automatically; on a bare window manager you may need to
  start `polkit-mate-authentication-agent-1` or similar yourself).
- **Cancelling the password prompt** — connect fails with "Authorization was
  cancelled"; just try again.

## Building the .deb from source

```bash
git clone https://github.com/tohidmalik002/FreeVPN.git
cd FreeVPN
npm install
npm run dist:linux
```

The package is written to `release/freevpn_<version>_amd64.deb`.

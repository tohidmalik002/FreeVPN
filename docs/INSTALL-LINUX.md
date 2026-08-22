# Installing FreeVPN on Linux (Ubuntu / Linux Mint)

## Install

```bash
sudo dpkg -i freevpn_0.2.0_amd64.deb
```

If it complains about missing dependencies, run:

```bash
sudo apt --fix-broken install
```

This pulls in `openvpn` and `policykit-1` if you don't already have them —
both are declared as package dependencies, so a plain `dpkg -i` normally
succeeds outright on Ubuntu/Mint.

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
local control channel.

## Uninstall

```bash
sudo dpkg -r freevpn
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

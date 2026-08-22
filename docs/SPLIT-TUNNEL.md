# Per-app split tunnelling (work in progress)

Goal: route **one chosen app** (e.g. a browser or a game) through the VPN, while the rest of
the system keeps using the normal connection.

Windows has no per-app VPN API, so we build it from two halves:

```
Selected app ──(ProxiFyre: capture by PID)──► local SOCKS5 proxy ──(bind to VPN adapter + host route)──► OpenVPN tunnel
Everything else ─────────────────────────────────────────────────────────────────────────────────────► direct internet
```

- **Right half — egress (Stage 0, built):** `tools/split-proxy.js` is a SOCKS5 proxy whose
  outbound sockets are bound to the VPN adapter's IP and given a per-destination host route
  through the tunnel. Anything connecting through it exits via the VPN.
- **Left half — capture (Stage 1, next):** [ProxiFyre](https://github.com/wiresock/proxifyre)
  (built on a signed packet-filter driver) forces a chosen app's TCP/UDP into that SOCKS proxy,
  so it works for apps that aren't proxy-aware.

Staging it this way means Stage 0 can be proven with just a browser — **no driver required yet.**

---

## Stage 0 test — prove tunnel egress (browser, no driver)

**You need:** the VPN connected in **split mode**, and an **admin** terminal.

1. **Connect in split mode.** In FreeVPN, tick **“Split tunnel (beta)”**, then connect to a
   server (pick one whose country differs from yours so the test is obvious). In split mode the
   tunnel is *not* your default route, so your normal browsing still uses your real IP.

2. **Start the split proxy** in an **Administrator** terminal (routes need admin):

   ```bash
   cd C:\Users\touhi\Projects\FreeVPN
   node tools/split-proxy.js
   ```

   It should print the detected VPN adapter and `SOCKS5 proxy : 127.0.0.1:1080`.

3. **Point a browser at the proxy.** Easiest is Firefox (its proxy is independent of Windows):
   Settings → Network Settings → **Manual proxy** → SOCKS Host `127.0.0.1`, Port `1080`,
   SOCKS v5, and tick **“Proxy DNS when using SOCKS v5.”**
   (Or launch Chrome with `chrome.exe --proxy-server="socks5://127.0.0.1:1080"`.)

4. **Compare IPs:**
   - In the **proxied browser**, open <https://ifconfig.me> → should show the **VPN country**.
   - In any **other app / a non-proxied browser**, open the same site → should show your
     **real IP**.

   If the two differ, the egress half works. 🎉

**Stop:** Ctrl+C in the proxy terminal — it removes the host routes it added.

### Known Stage-0 limits
- **TCP only.** UDP/QUIC isn't routed; browsers fall back to TCP for HTTPS. (A later stage
  adds UDP via ProxiFyre.)
- **DNS** is resolved locally by the proxy — a possible DNS leak. Firefox's “Proxy DNS when
  using SOCKS v5” keeps lookups inside the browser tab; full system DNS handling comes later.
- Host routes are **global while active**, so another app hitting the exact same destination IP
  would also take the tunnel for that moment. Rare in practice; ProxiFyre (Stage 1) removes the
  need for host routes entirely by keeping capture per-PID.

---

> **Status: VERIFIED WORKING (2026-08-19).** With Edge chosen and the VPN connected in split
> mode, a clean (incognito) Edge session exits via the VPN country while the rest of the system
> stays on the normal connection. TCP only for now — QUIC/UDP can still bypass (see Limitations).

## Stage 1 — capture any app by PID (built + verified)

- **1a — app picker (done):** tick apps / add by file; saved to `userData/selected-apps.json`
  (`src/main/apps.ts`, picker modal in the renderer).
- **1b — ProxiFyre wiring (done, needs testing):** on connect in chosen-apps mode, FreeVPN
  starts the in-process SOCKS proxy (`src/main/splitProxy.ts`) and **ProxiFyre**
  (`src/main/proxifyre.ts`), which forces the selected exes' TCP into it. On disconnect/quit,
  both stop.

### One-time setup to actually route apps

ProxiFyre and its driver are **not bundled** (a driver install needs admin and is your choice):

1. Install the **Windows Packet Filter** driver + **ProxiFyre** from
   <https://github.com/wiresock/proxifyre>.
2. Put `ProxiFyre.exe` where FreeVPN looks for it — either:
   - `vendor/proxifyre/ProxiFyre.exe` inside the app folder, or
   - `C:\Program Files\ProxiFyre\ProxiFyre.exe`.
3. FreeVPN detects it — the picker area shows **“✓ Per-app routing engine ready.”**

Then: tick **VPN for chosen apps only**, pick apps, connect. FreeVPN writes ProxiFyre's
`app-config.json` (your exes → `127.0.0.1:1080`) and starts it. Watch the connection log for
`[split] per-app routing active for: …`.

**If ProxiFyre is absent**, split mode still connects — it just skips per-app capture and logs
that, so nothing breaks.

### Isolation guarantee
None of this runs unless you tick **VPN for chosen apps only** *and* have apps selected. With
the toggle off (the default), the connect path is byte-for-byte the old whole-device VPN.

### Still to do (Windows)
- UDP + DNS handling (Stage-0 TCP-only limits still apply); a kill-switch if the tunnel drops;
  bundling ProxiFyre to remove the manual install.

---

## Linux: network namespace instead of a packet-filter driver

Windows has no per-app VPN API, but it does have ProxiFyre — a signed packet-filter driver
that can transparently capture an *already-running* process's traffic by PID. Linux has no
equivalent driver, and retrofitting network isolation onto a process that's already running
needs heavy tooling (CRIU-style namespace migration) that isn't worth the complexity here.

Instead, Linux uses the standard, well-supported primitive for this: a dedicated **network
namespace** whose only route out is the VPN tunnel, and FreeVPN **launches** the chosen app
inside it — see `src/main/linuxSplit.ts`. This is a real UX difference from Windows ("pick a
running app" becomes "pick an app to launch through the VPN"), but it's the same technique
Mullvad's own Linux split-tunneling uses, and it gets full TCP **and** UDP **and** DNS
isolation for free — no SOCKS relay, so none of the Windows Stage-0 limits above apply.

```
Chosen app (launched by FreeVPN) ──┐
                                    ├─ netns "freevpn0" ── veth ── policy route ── tun (VPN)
                                    │   (only route out is the tunnel)
Everything else ────────────────────────────────────────────────────────────────► direct internet
```

- `scripts/linux-split-up.sh` (root, via `pkexec` — never the whole app): creates the
  namespace, a veth pair into it, a resolv.conf pointing at public DNS routed through the
  tunnel (the namespace's loopback is isolated, so it can't reach the host's
  `127.0.0.53` stub resolver), and a **policy route** (`ip rule` + a dedicated table) that
  sends only that namespace's traffic through the tunnel — split mode intentionally doesn't
  make the tunnel the host's default route, so without the policy route the namespace's
  packets would just follow the host's normal route like everything else.
- `scripts/linux-split-down.sh` reverses it.
- Apps are launched inside the namespace via `pkexec ip netns exec freevpn0 runuser -u
  $USER -- <path>` — the `runuser` step drops back to the invoking (non-root) user, so the
  app itself never runs elevated, only the brief namespace-entry step does.
- **Kill-switch by construction:** if the tunnel drops, the namespace's policy route points
  at a tun device that no longer exists, so launched apps simply lose connectivity — there's
  no separate mechanism to fail.
- Disconnecting the VPN does **not** kill apps already launched into the namespace (killing
  someone's browser because they disconnected would be surprising); they just lose their
  route until you reconnect.

### Still to do (Linux)
- No "currently running apps" list yet (`apps.ts`'s `listRunningApps()` is Windows-only,
  via PowerShell) — app selection is browse-for-executable only.
- DNS is hardcoded to public resolvers (1.1.1.1 / 9.9.9.9) rather than whatever the VPN
  server pushes, since the plain CLI needs an `--up` script to apply pushed DNS and we don't
  run one yet.

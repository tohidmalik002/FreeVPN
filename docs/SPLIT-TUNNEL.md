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

## Stage 1 (planned) — capture any app by PID

1. Bundle/download **ProxiFyre** + its Windows Packet Filter driver.
2. UI: pick an app (process list / browse for an .exe); write ProxiFyre's app list.
3. Start ProxiFyre pointed at `127.0.0.1:1080` (our proxy) → the chosen app's traffic is forced
   through the tunnel; everything else stays direct.
4. Handle UDP and DNS properly; add a kill-switch (block the app if the tunnel drops).

**Caveat:** packet-filter drivers are sometimes flagged by antivirus, and the driver install
needs admin. This is the unavoidable tax of per-app tunnelling without our own signed driver.

#!/bin/sh
# Installs a polkit action that grants auth_admin_keep (short-lived cached
# auth, ~5 min) for the exact binaries FreeVPN elevates via pkexec.
#
# Without this, pkexec falls back to the generic org.freedesktop.policykit.exec
# action, which on stock Linux Mint/Ubuntu prompts for a password on every
# single pkexec call. "Fastest" connect can try up to 6 servers in one run,
# each spawning its own `pkexec openvpn ...` — that meant up to 6 separate
# password prompts for one click. Caching the auth for a few minutes lets one
# unlock cover an entire failover run and any manual reconnects shortly after.
#
# Scoped to specific absolute paths (not a blanket "run anything as root")
# so this can't be used to elevate arbitrary programs.
set -e

POLICY_DIR=/usr/share/polkit-1/actions
POLICY_FILE="$POLICY_DIR/com.freevpn.pkexec.policy"

mkdir -p "$POLICY_DIR"
cat > "$POLICY_FILE" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE policyconfig PUBLIC "-//freedesktop//DTD PolicyKit Policy Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/PolicyKit/1/policyconfig.dtd">
<policyconfig>
  <vendor>FreeVPN</vendor>
  <vendor_url>https://github.com/tohidmalik002/FreeVPN</vendor_url>

  <action id="com.freevpn.pkexec.openvpn-sbin">
    <description>Run OpenVPN to bring up the FreeVPN tunnel</description>
    <message>Authentication is required to start the FreeVPN tunnel</message>
    <icon_name>network-vpn</icon_name>
    <defaults>
      <allow_any>auth_admin_keep</allow_any>
      <allow_inactive>auth_admin_keep</allow_inactive>
      <allow_active>auth_admin_keep</allow_active>
    </defaults>
    <annotate key="org.freedesktop.policykit.exec.path">/usr/sbin/openvpn</annotate>
    <annotate key="org.freedesktop.policykit.exec.allow_gui">true</annotate>
  </action>

  <action id="com.freevpn.pkexec.openvpn-bin">
    <description>Run OpenVPN to bring up the FreeVPN tunnel</description>
    <message>Authentication is required to start the FreeVPN tunnel</message>
    <icon_name>network-vpn</icon_name>
    <defaults>
      <allow_any>auth_admin_keep</allow_any>
      <allow_inactive>auth_admin_keep</allow_inactive>
      <allow_active>auth_admin_keep</allow_active>
    </defaults>
    <annotate key="org.freedesktop.policykit.exec.path">/usr/bin/openvpn</annotate>
    <annotate key="org.freedesktop.policykit.exec.allow_gui">true</annotate>
  </action>

  <action id="com.freevpn.pkexec.split-up">
    <description>Set up FreeVPN's per-app split-tunnel routing namespace</description>
    <message>Authentication is required to set up per-app VPN routing</message>
    <icon_name>network-vpn</icon_name>
    <defaults>
      <allow_any>auth_admin_keep</allow_any>
      <allow_inactive>auth_admin_keep</allow_inactive>
      <allow_active>auth_admin_keep</allow_active>
    </defaults>
    <annotate key="org.freedesktop.policykit.exec.path">/opt/FreeVPN/resources/scripts/linux-split-up.sh</annotate>
    <annotate key="org.freedesktop.policykit.exec.allow_gui">true</annotate>
  </action>

  <action id="com.freevpn.pkexec.split-down">
    <description>Tear down FreeVPN's per-app split-tunnel routing namespace</description>
    <message>Authentication is required to remove per-app VPN routing</message>
    <icon_name>network-vpn</icon_name>
    <defaults>
      <allow_any>auth_admin_keep</allow_any>
      <allow_inactive>auth_admin_keep</allow_inactive>
      <allow_active>auth_admin_keep</allow_active>
    </defaults>
    <annotate key="org.freedesktop.policykit.exec.path">/opt/FreeVPN/resources/scripts/linux-split-down.sh</annotate>
    <annotate key="org.freedesktop.policykit.exec.allow_gui">true</annotate>
  </action>
</policyconfig>
EOF

chmod 644 "$POLICY_FILE"

exit 0

#!/bin/bash
# Reverses linux-split-up.sh. Run as root (via pkexec).
# Args: <netns> <veth-host> <ns-ip/cidr> <tun-device>
set -uo pipefail

NETNS=$1; VETH_HOST=$2; NS_CIDR=$3; TUN=$4
TABLE_ID=9271

ip rule del from "$NS_CIDR" table "$TABLE_ID" 2>/dev/null || true
ip route flush table "$TABLE_ID" 2>/dev/null || true

iptables -w -t nat -D POSTROUTING -s "$NS_CIDR" -o "$TUN" -j MASQUERADE 2>/dev/null || true
iptables -w -D FORWARD -i "$VETH_HOST" -o "$TUN" -j ACCEPT 2>/dev/null || true
iptables -w -D FORWARD -i "$TUN" -o "$VETH_HOST" -m state --state ESTABLISHED,RELATED -j ACCEPT 2>/dev/null || true

ip link del "$VETH_HOST" 2>/dev/null || true
ip netns del "$NETNS" 2>/dev/null || true
rm -rf "/etc/netns/$NETNS"

exit 0

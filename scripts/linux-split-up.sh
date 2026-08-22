#!/bin/bash
# Sets up an isolated network namespace whose only route out is the VPN
# tunnel, so apps launched inside it can't reach the internet any other way
# (kill-switch by construction: if the tunnel drops, the namespace has no
# route at all until FreeVPN reconnects and re-runs this script).
#
# Run as root (via pkexec). Args: <netns> <veth-host> <veth-ns> <host-ip/cidr>
# <ns-ip/cidr> <tun-device> <dns-server...>
set -euo pipefail

NETNS=$1; VETH_HOST=$2; VETH_NS=$3; HOST_CIDR=$4; NS_CIDR=$5; TUN=$6
shift 6
DNS_SERVERS=("$@")

HOST_IP=${HOST_CIDR%/*}

# Idempotent: clear any leftovers from a previous run that didn't tear down
# cleanly (crash, kill -9) before creating anything.
ip netns del "$NETNS" 2>/dev/null || true
ip link del "$VETH_HOST" 2>/dev/null || true

ip netns add "$NETNS"
ip link add "$VETH_HOST" type veth peer name "$VETH_NS"
ip link set "$VETH_NS" netns "$NETNS"

ip addr add "$HOST_CIDR" dev "$VETH_HOST"
ip link set "$VETH_HOST" up

ip netns exec "$NETNS" ip addr add "$NS_CIDR" dev "$VETH_NS"
ip netns exec "$NETNS" ip link set "$VETH_NS" up
ip netns exec "$NETNS" ip link set lo up
ip netns exec "$NETNS" ip route add default via "$HOST_IP"

# `ip netns exec` bind-mounts /etc/netns/<name>/resolv.conf over
# /etc/resolv.conf for anything it launches — the namespace's own loopback
# is isolated from the host's, so it can't reach a systemd-resolved stub at
# 127.0.0.53 the way host processes do. Point it at real resolvers instead,
# routed through the tunnel like everything else in the namespace.
mkdir -p "/etc/netns/$NETNS"
: > "/etc/netns/$NETNS/resolv.conf"
for ns in "${DNS_SERVERS[@]}"; do
  echo "nameserver $ns" >> "/etc/netns/$NETNS/resolv.conf"
done

sysctl -qw net.ipv4.ip_forward=1

# Split mode deliberately does NOT push redirect-gateway (see openvpn.ts), so
# the host's own default route stays the normal one — the host's ordinary
# routing table would send this namespace's packets out the normal interface
# too, same as everything else. A policy route sends only NS_CIDR's traffic
# through a table whose sole default route is the tunnel, regardless of what
# the host's main table says. This IS the split (not just NAT plumbing) —
# without it every packet from the namespace would silently exit normally.
# Only one split-tunnel namespace runs at a time, so a fixed table ID is fine.
TABLE_ID=9271
ip rule del from "$NS_CIDR" table "$TABLE_ID" 2>/dev/null || true
ip route flush table "$TABLE_ID" 2>/dev/null || true
ip route add default dev "$TUN" table "$TABLE_ID"
ip rule add from "$NS_CIDR" table "$TABLE_ID" priority 100

# NAT: NS_CIDR is a private address the VPN server has no route back to, so
# outbound packets are rewritten to the tunnel's own address.
iptables -w -t nat -A POSTROUTING -s "$NS_CIDR" -o "$TUN" -j MASQUERADE
iptables -w -A FORWARD -i "$VETH_HOST" -o "$TUN" -j ACCEPT
iptables -w -A FORWARD -i "$TUN" -o "$VETH_HOST" -m state --state ESTABLISHED,RELATED -j ACCEPT

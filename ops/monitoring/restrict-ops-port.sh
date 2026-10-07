#!/bin/bash
# Tencent public NAT reaches the private NIC: binding alone is insufficient.
set -euo pipefail
test "$(hostname)" = VM-26-196-ubuntu
args=(-p tcp -d 10.11.26.196 --dport 9443 ! -s 10.11.20.216/32 -j DROP)
/usr/sbin/iptables -w -C INPUT "${args[@]}" 2>/dev/null || /usr/sbin/iptables -w -I INPUT 1 "${args[@]}"

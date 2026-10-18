#!/usr/bin/env bash
set -euo pipefail
# Private user/network namespace: never changes the host's qdiscs.
if [[ ${1:-} != --inner ]]; then
  exec unshare -Urn bash "$0" --inner "$@"
fi
shift
ip link set lo up
ip link add cdbench0 type veth peer name cdbench1
ip addr add 10.77.0.1/24 dev cdbench0
ip link set cdbench0 up
ip link set cdbench1 up
# Shape UDP only. Local HTTP/WebSocket relay remains available for e2e runs.
tc qdisc add dev lo root handle 1: prio
tc qdisc add dev lo parent 1:3 handle 30: netem delay "${CD_NETEM_DELAY:-20ms}" rate "${CD_NETEM_RATE:-200mbit}" limit 20000
tc filter add dev lo protocol ip parent 1: prio 1 u32 match ip protocol 17 0xff flowid 1:3
exec "$@"

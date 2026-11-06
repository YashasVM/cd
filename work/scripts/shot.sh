#!/bin/bash
# usage: shot.sh <name> [am start extras...]
A=~/Android/Sdk/platform-tools/adb; S=emulator-5558; name=$1; shift
$A -s $S shell am start -W -n in.yash0.cd/.MainActivity "$@" >/dev/null 2>&1
sleep ${WAIT:-2.5}
$A -s $S exec-out screencap -p > /home/yvm/code/cd-aw-ui/work/${SHOTS:-shots}/$name.png

#!/usr/bin/env bash
set -euo pipefail

version="v11.5.2"
target_dir="${CD_BIN_DIR:-bin}"
mkdir -p "$target_dir"

case "$(uname -s):$(uname -m)" in
  Linux:x86_64) asset="croc_${version}_Linux-64bit.tar.gz" ;;
  Linux:aarch64|Linux:arm64) asset="croc_${version}_Linux-ARM64.tar.gz" ;;
  Darwin:x86_64) asset="croc_${version}_macOS-64bit.tar.gz" ;;
  Darwin:arm64) asset="croc_${version}_macOS-ARM64.tar.gz" ;;
  *) echo "unsupported platform: $(uname -s) $(uname -m)" >&2; exit 1 ;;
esac

temp_dir=$(mktemp -d)
trap 'rm -rf "$temp_dir"' EXIT
curl -fsSL "https://github.com/schollz/croc/releases/download/${version}/${asset}" -o "$temp_dir/croc.tgz"
tar -xzf "$temp_dir/croc.tgz" -C "$temp_dir"
install -m 0755 "$temp_dir/croc" "$target_dir/croc"
echo "Installed croc ${version} at ${target_dir}/croc"

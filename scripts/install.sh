#!/bin/sh
set -eu
umask 077

repository="YashasVM/cd"
version="${CD_VERSION:-${CDX_VERSION:-latest}}"
install_dir="${CD_INSTALL_DIR:-${CDX_INSTALL_DIR:-${HOME}/.local/bin}}"

case "$version" in
  latest|v*) ;;
  *) echo "cd: CD_VERSION must be 'latest' or a tag like v1.0.0 (got '$version')" >&2; exit 1 ;;
esac

case "$(uname -s)" in
  Linux) operating_system="linux" ;;
  Darwin) operating_system="darwin" ;;
  MINGW*|MSYS*|CYGWIN*) operating_system="windows" ;;
  *) echo "cd: unsupported operating system: $(uname -s)" >&2; exit 1 ;;
esac

case "$(uname -m)" in
  x86_64|amd64) architecture="amd64" ;;
  arm64|aarch64) architecture="arm64" ;;
  *) echo "cd: unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

suffix=""
[ "$operating_system" = "windows" ] && suffix=".exe"
asset="cd-${operating_system}-${architecture}${suffix}"
if [ "$version" = "latest" ]; then
  base_url="https://github.com/${repository}/releases/latest/download"
else
  base_url="https://github.com/${repository}/releases/download/${version}"
fi

temporary_dir="$(mktemp -d)"
trap 'rm -rf "$temporary_dir"' EXIT INT TERM
curl --fail --location --silent --show-error "${base_url}/${asset}" --output "${temporary_dir}/${asset}"
curl --fail --location --silent --show-error "${base_url}/checksums.txt" --output "${temporary_dir}/checksums.txt"

expected="$(awk -v file="$asset" '$2 == file { print $1 }' "${temporary_dir}/checksums.txt")"
[ -n "$expected" ] || { echo "cd: release checksum is missing" >&2; exit 1; }
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "${temporary_dir}/${asset}" | awk '{ print $1 }')"
elif command -v shasum >/dev/null 2>&1; then
  actual="$(shasum -a 256 "${temporary_dir}/${asset}" | awk '{ print $1 }')"
else
  echo "cd: sha256sum or shasum is required" >&2
  exit 1
fi
[ "$actual" = "$expected" ] || { echo "cd: checksum verification failed" >&2; exit 1; }

mkdir -p "$install_dir"
install_target="${install_dir}/cd${suffix}"
install_temporary="${install_target}.tmp.$$"
trap 'rm -rf "$temporary_dir"; rm -f "$install_temporary"' EXIT INT TERM
cp "${temporary_dir}/${asset}" "$install_temporary"
chmod 0755 "$install_temporary"
mv -f "$install_temporary" "$install_target"
# Remove the old `cdx` binary so two names never diverge.
rm -f "${install_dir}/cdx${suffix}"
echo "installed cd to ${install_target}"
case ":${PATH}:" in
  *":${install_dir}:"*) ;;
  *)
    echo "add ${install_dir} to PATH, then run: cd send <file>" >&2
    ;;
esac
if [ "$operating_system" != "windows" ]; then
  echo "note: 'cd' is also the shell builtin — add 'eval \"\$(cd shell-init)\"' to ~/.bashrc or ~/.zshrc so 'cd send' reaches CD" >&2
fi

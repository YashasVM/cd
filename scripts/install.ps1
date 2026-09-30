# cdx installer for Windows (PowerShell 5.1+ and PowerShell 7+).
# One-liner:
#   irm https://cd.yash0.in/install.ps1 | iex
# If ExecutionPolicy blocks it, use:
#   powershell -ExecutionPolicy Bypass -c "irm https://cd.yash0.in/install.ps1 | iex"
#
# Mirrors scripts/install.sh: downloads the checksum-verified
# cdx-windows-<arch>.exe release asset from GitHub and installs it as
# <install-dir>\cdx.exe (default: $HOME\.local\bin\cdx.exe).
#
# Environment overrides (same names as install.sh):
#   $env:CD_VERSION     'latest' (default) or a tag like 'v1.0.0'
#   $env:CD_INSTALL_DIR custom install directory

$ErrorActionPreference = 'Stop'

$Repository = 'YashasVM/cd'

$Version = if ($env:CD_VERSION) { $env:CD_VERSION } elseif ($env:CDX_VERSION) { $env:CDX_VERSION } else { 'latest' }
if ($Version -ne 'latest' -and -not $Version.StartsWith('v')) {
  Write-Error "cdx: CD_VERSION must be 'latest' or a tag like v1.0.0 (got '$Version')"
}

$InstallDir = if ($env:CD_INSTALL_DIR) { $env:CD_INSTALL_DIR } elseif ($env:CDX_INSTALL_DIR) { $env:CDX_INSTALL_DIR } else { Join-Path $HOME '.local\bin' }

try {
  $osArch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
} catch {
  $osArch = ''
}
switch ($osArch) {
  'X64' { $Architecture = 'amd64' }
  'Arm64' { $Architecture = 'arm64' }
  default {
    $rawArch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    switch (([string]$rawArch).ToUpperInvariant()) {
      'AMD64' { $Architecture = 'amd64' }
      'ARM64' { $Architecture = 'arm64' }
      default { Write-Error "cdx: unsupported architecture: $rawArch" }
    }
  }
}

$Asset = "cdx-windows-$Architecture.exe"
if ($Version -eq 'latest') {
  $BaseUrl = "https://github.com/$Repository/releases/latest/download"
} else {
  $BaseUrl = "https://github.com/$Repository/releases/download/$Version"
}

# Windows PowerShell 5.1 defaults to TLS 1.0; GitHub requires TLS 1.2.
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
} catch { }

$TempDir = Join-Path ([IO.Path]::GetTempPath()) ('cdx-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $TempDir | Out-Null
try {
  Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/$Asset" -OutFile (Join-Path $TempDir $Asset)
  Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/checksums.txt" -OutFile (Join-Path $TempDir 'checksums.txt')

  $line = Get-Content (Join-Path $TempDir 'checksums.txt') | Where-Object { $_ -match "\s$([regex]::Escape($Asset))\s*$" } | Select-Object -First 1
  if (-not $line) { Write-Error 'cdx: release checksum is missing' }
  $Expected = ($line -split '\s+')[0]
  if (-not $Expected) { Write-Error 'cdx: release checksum is missing' }
  $Actual = (Get-FileHash -Path (Join-Path $TempDir $Asset) -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($Actual -ne $Expected.ToLowerInvariant()) { Write-Error 'cdx: checksum verification failed' }

  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  $Target = Join-Path $InstallDir 'cdx.exe'
  Copy-Item -Path (Join-Path $TempDir $Asset) -Destination $Target -Force
  # Earlier releases installed the CLI as cd.exe. Remove that copy, but only
  # if it really is a CD binary.
  $OldBinary = Join-Path $InstallDir 'cd.exe'
  if ((Test-Path $OldBinary) -and (Select-String -Path $OldBinary -Pattern 'cd-transfer-v1' -SimpleMatch -Quiet)) {
    Remove-Item -Path $OldBinary -Force -ErrorAction SilentlyContinue
    Write-Output "removed the old $OldBinary (the CLI is now called cdx)"
  }
  Write-Output "installed cdx to $Target"

  $inPath = ($env:Path -split ';') -contains $InstallDir
  if (-not $inPath) {
    try {
      $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
      if (($userPath -split ';') -notcontains $InstallDir) {
        $newPath = (($userPath + ';' + $InstallDir).Trim(';'))
        [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
      }
    } catch {
      Write-Warning "cdx: could not persist PATH update: $($_.Exception.Message)"
    }
    $env:Path += ';' + $InstallDir
    Write-Warning "added $InstallDir to PATH (restart your terminal if 'cdx' is not found), then run: cdx send <file>"
  }
} finally {
  Remove-Item -Recurse -Force $TempDir -ErrorAction SilentlyContinue
}

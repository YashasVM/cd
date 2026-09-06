#requires -Version 5.1
<#
.SYNOPSIS
  Installs or removes CD's per-user "Send to Phone" shortcut.
.EXAMPLE
  .\Install-SendToPhone.ps1 -Mode Install -ExePath .\artifacts\win-x64\CD.exe
  .\Install-SendToPhone.ps1 -Mode Remove
.NOTES
  Windows SendTo forwards all selected Explorer files/folders as arguments.
  -SendToDirectory is intended for non-destructive tests.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet('Install', 'Remove')]
    [string] $Mode,

    [string] $ExePath,

    [string] $SendToDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$shortcutName = 'Send to Phone.lnk'
$shortcutDescription = 'CD Send to Phone'

function Resolve-SendToDirectory {
    if ($SendToDirectory) {
        $path = [Environment]::ExpandEnvironmentVariables($SendToDirectory)
    }
    else {
        if (-not $env:APPDATA) { throw 'APPDATA is not set.' }
        $path = Join-Path $env:APPDATA 'Microsoft\Windows\SendTo'
    }

    if (-not (Test-Path -LiteralPath $path -PathType Container)) {
        if ($PSCmdlet.ShouldProcess($path, 'Create SendTo directory')) {
            New-Item -ItemType Directory -Path $path -Force | Out-Null
        }
    }
    return (Resolve-Path -LiteralPath $path).Path
}

function Get-ExistingShortcut {
    param([Parameter(Mandatory)][string] $Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    if ([IO.Path]::GetExtension($Path) -ne '.lnk') {
        throw "Refusing to replace non-shortcut file: $Path"
    }

    $shell = New-Object -ComObject WScript.Shell
    try {
        return $shell.CreateShortcut($Path)
    }
    catch {
        throw "Refusing to replace an unreadable shortcut: $Path"
    }
}

$sendTo = Resolve-SendToDirectory
$shortcutPath = Join-Path $sendTo $shortcutName
$existing = Get-ExistingShortcut $shortcutPath

if ($Mode -eq 'Remove') {
    if ($null -eq $existing) {
        Write-Output "Not installed: $shortcutPath"
        exit 0
    }
    if ($existing.Description -ne $shortcutDescription) {
        throw "Refusing to remove a shortcut that is not owned by CD: $shortcutPath"
    }
    if ($PSCmdlet.ShouldProcess($shortcutPath, 'Remove CD Send to Phone shortcut')) {
        Remove-Item -LiteralPath $shortcutPath -Force
        Write-Output "Removed: $shortcutPath"
    }
    exit 0
}

if ([string]::IsNullOrWhiteSpace($ExePath)) {
    throw '-ExePath is required when installing.'
}
$exe = (Resolve-Path -LiteralPath $ExePath -ErrorAction Stop).Path
if (-not (Test-Path -LiteralPath $exe -PathType Leaf) -or [IO.Path]::GetExtension($exe) -ne '.exe') {
    throw "-ExePath must point to an existing .exe: $ExePath"
}

if ($null -ne $existing -and $existing.Description -ne $shortcutDescription) {
    throw "Refusing to replace a shortcut that is not owned by CD: $shortcutPath"
}

if ($PSCmdlet.ShouldProcess($shortcutPath, 'Install CD Send to Phone shortcut')) {
    if ($null -ne $existing) { Remove-Item -LiteralPath $shortcutPath -Force }
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $exe
    $shortcut.WorkingDirectory = Split-Path -Parent $exe
    $shortcut.Description = $shortcutDescription
    $shortcut.IconLocation = "$exe,0"
    $shortcut.Save()
    Write-Output "Installed: $shortcutPath"
}

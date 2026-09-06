param(
    [ValidateSet('Debug', 'Release')]
    [string]$Configuration = 'Release',
    [ValidateSet('win-x64', 'win-arm64')]
    [string]$Runtime = 'win-x64',
    [bool]$SelfContained = $true
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$artifact = Join-Path $PSScriptRoot "artifacts\$Runtime"
$project = Join-Path $PSScriptRoot 'src\CD.Windows\CD.Windows.csproj'
$go = Get-Command go -ErrorAction SilentlyContinue
if (-not $go -and (Test-Path -LiteralPath 'C:\Program Files\Go\bin\go.exe')) {
    $go = Get-Item 'C:\Program Files\Go\bin\go.exe'
}
if (-not $go) {
    throw 'Go 1.27+ is required to build cdx.exe. Install it with: winget install GoLang.Go'
}
$goPath = if ($go.Source) { $go.Source } else { $go.FullName }
$selfContainedValue = $SelfContained.ToString().ToLowerInvariant()

New-Item -ItemType Directory -Force -Path $artifact | Out-Null

dotnet publish $project `
    --configuration $Configuration `
    --runtime $Runtime `
    --self-contained $selfContainedValue `
    --output $artifact
if ($LASTEXITCODE -ne 0) { throw 'The Windows UI publish failed.' }

Push-Location (Join-Path $repoRoot 'cdx')
try {
    $env:CGO_ENABLED = '0'
    & $goPath build -trimpath -ldflags '-s -w' -o (Join-Path $artifact 'cdx.exe') .
    if ($LASTEXITCODE -ne 0) { throw 'The cdx transfer engine build failed.' }
}
finally {
    Pop-Location
}

Write-Host "CD is ready: $artifact\CD.exe"

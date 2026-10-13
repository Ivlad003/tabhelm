# TabHelm installer for Windows (PowerShell 5.1+).
#   irm https://ivlad003.github.io/tabhelm/install.ps1 | iex
#
# Downloads the latest release into %USERPROFILE%\.tabhelm\app, installs the
# native host's dependencies and registers it (registry, HKCU) for Chrome,
# Edge, Chromium and Brave. Chrome only loads unpacked extensions by hand, so
# the last step (Load unpacked) is printed at the end.
#
# Environment overrides:
#   TABHELM_HOME     install root (default %USERPROFILE%\.tabhelm)
#   TABHELM_TARBALL  release URL or local .tar.gz path (default: latest GitHub release)

$ErrorActionPreference = 'Stop'
$repo = 'Ivlad003/tabhelm'
$root = if ($env:TABHELM_HOME) { $env:TABHELM_HOME } else { Join-Path $env:USERPROFILE '.tabhelm' }
$app = Join-Path $root 'app'
$tarball = if ($env:TABHELM_TARBALL) { $env:TABHELM_TARBALL } else { "https://github.com/$repo/releases/latest/download/tabhelm.tar.gz" }

function Fail($msg) { Write-Host "x $msg" -ForegroundColor Red; throw $msg }
function Step($msg) { Write-Host $msg -ForegroundColor Cyan }

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail 'Node.js 20+ is required: https://nodejs.org (restart the terminal after installing).' }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Fail 'npm is required (it ships with Node.js).' }
if (-not (Get-Command tar -ErrorAction SilentlyContinue)) { Fail 'tar is required (included with Windows 10 1803+).' }
# Quotes inside arguments get mangled on the way to node, so parse `node -v` here.
$nodeVersion = (node -v).Trim()
$nodeMajor = [int]($nodeVersion.TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 20) { Fail "Node.js 20+ is required, found $nodeVersion." }

Step "Installing TabHelm into $app"
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("tabhelm-" + [System.Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  $archive = Join-Path $tmp 'tabhelm.tar.gz'
  if (Test-Path $tarball) { Copy-Item $tarball $archive }
  else {
    Write-Host "Downloading $tarball"
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $tarball -OutFile $archive -UseBasicParsing
  }
  tar -xzf $archive -C $tmp
  if ($LASTEXITCODE -ne 0) { Fail 'Could not unpack the archive.' }
  $src = Get-ChildItem -Path $tmp -Directory -Filter 'tabhelm-*' | Select-Object -First 1
  if (-not $src) { Fail 'The archive does not contain a tabhelm-<version> folder.' }

  New-Item -ItemType Directory -Path $root -Force | Out-Null
  if (Test-Path $app) { Remove-Item $app -Recurse -Force }
  Move-Item $src.FullName $app

  Step 'Installing host dependencies (this can take a minute)'
  Push-Location (Join-Path $app 'host')
  try {
    npm ci --omit=dev --no-audit --no-fund --loglevel=error
    if ($LASTEXITCODE -ne 0) { Fail 'npm ci failed.' }
    Step 'Registering the native host'
    node scripts/install.js
    if ($LASTEXITCODE -ne 0) { Fail 'Registering the native host failed.' }
  } finally { Pop-Location }
} finally {
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

$version = (Get-Content (Join-Path $app 'extension\manifest.json') -Raw | ConvertFrom-Json).version
Write-Host ''
Write-Host "OK TabHelm $version installed" -ForegroundColor Green
Write-Host @"

Last step - load the extension in Chrome:
  1. Open chrome://extensions
  2. Turn on "Developer mode" (top right)
  3. Click "Load unpacked" and choose:
       $app\extension

Then click the TabHelm icon on any page, pick an agent and send a message.
Agents found on this machine are listed in the panel; install more with:
  cd "$app\host"; npm run install-agent -- --list

To update later, run the same install command again.
"@

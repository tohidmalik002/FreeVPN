# FreeVPN - per-app VPN setup
# Installs the two extra pieces needed for "VPN for chosen apps only":
#   1. ProxiFyre  -> copied into <project>\vendor\proxifyre\
#   2. Windows Packet Filter driver (ProxiFyre depends on it)
# Also checks for the .NET Desktop Runtime.
#
# Run via "Setup per-app VPN (Admin).cmd" (self-elevates), or:
#   powershell -ExecutionPolicy Bypass -File scripts\setup-perapp.ps1
# Override auto-download with -ProxifyreUrl <zip> / -DriverUrl <installer>.

param(
  [string]$ProxifyreUrl = "",
  [string]$DriverUrl = ""
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ua = @{ "User-Agent" = "FreeVPN-setup" }

function Info($m) { Write-Host "  $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "  [ok] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [!]  $m" -ForegroundColor Yellow }

$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($id)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)) {
  Warn "Please run this as Administrator (use 'Setup per-app VPN (Admin).cmd')."
  exit 1
}

$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$vendor = Join-Path $projectRoot "vendor\proxifyre"
$tmp = Join-Path $env:TEMP ("freevpn-setup-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

Write-Host ""
Write-Host "=== FreeVPN per-app setup ===" -ForegroundColor White
Write-Host "  Project : $projectRoot"
Write-Host ""

function Get-LatestAsset($repo, $pattern) {
  try {
    $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest" -Headers $ua
    return ($rel.assets | Where-Object { $_.name -match $pattern } | Select-Object -First 1)
  } catch {
    return $null
  }
}

# --- 1. ProxiFyre ---
Write-Host "[1/2] ProxiFyre" -ForegroundColor White
try {
  $url = $ProxifyreUrl
  if (-not $url) {
    $a = Get-LatestAsset "wiresock/proxifyre" "(?i)x64.*\.zip$"
    if (-not $a) { $a = Get-LatestAsset "wiresock/proxifyre" "(?i)\.zip$" }
    if ($a) { $url = $a.browser_download_url }
  }
  if (-not $url) { throw "couldn't find a ProxiFyre .zip automatically" }

  Info "Downloading $url"
  $zip = Join-Path $tmp "proxifyre.zip"
  Invoke-WebRequest -Uri $url -OutFile $zip -Headers $ua
  $ex = Join-Path $tmp "proxifyre"
  Expand-Archive -Path $zip -DestinationPath $ex -Force

  $exe = Get-ChildItem -Path $ex -Recurse -Filter "ProxiFyre.exe" | Select-Object -First 1
  if (-not $exe) { throw "ProxiFyre.exe not found inside the archive" }

  New-Item -ItemType Directory -Force -Path $vendor | Out-Null
  Copy-Item -Path (Join-Path $exe.Directory.FullName "*") -Destination $vendor -Recurse -Force
  Ok "ProxiFyre installed to $vendor"
} catch {
  Warn "ProxiFyre step failed: $($_.Exception.Message)"
  Warn "Get it from https://github.com/wiresock/proxifyre/releases and copy ProxiFyre.exe into:"
  Warn "  $vendor"
}

# --- 2. Windows Packet Filter driver ---
Write-Host ""
Write-Host "[2/2] Windows Packet Filter driver" -ForegroundColor White
$svc = Get-Service -Name "ndisrd" -ErrorAction SilentlyContinue
if ($svc) {
  Ok "Driver already installed (service 'ndisrd' present)"
} else {
  try {
    $durl = $DriverUrl
    if (-not $durl) {
      $d = Get-LatestAsset "wiresock/ndisapi" "(?i)x64.*\.(msi|exe)$"
      if (-not $d) { $d = Get-LatestAsset "wiresock/ndisapi" "(?i)\.(msi|exe)$" }
      if ($d) { $durl = $d.browser_download_url }
    }
    if (-not $durl) { throw "couldn't find the driver installer automatically" }

    Info "Downloading $durl"
    $inst = Join-Path $tmp ([IO.Path]::GetFileName($durl))
    Invoke-WebRequest -Uri $durl -OutFile $inst -Headers $ua

    Info "Launching the driver installer - follow its prompts (a reboot may be needed)."
    if ($inst.ToLower().EndsWith(".msi")) {
      Start-Process "msiexec.exe" -ArgumentList @("/i", $inst) -Wait
    } else {
      Start-Process $inst -Wait
    }
    Ok "Driver installer finished"
  } catch {
    Warn "Driver step failed: $($_.Exception.Message)"
    Warn "Install 'Windows Packet Filter' from https://github.com/wiresock/ndisapi/releases"
  }
}

Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
Write-Host ""
Write-Host "=== Setup complete ===" -ForegroundColor White
if (Test-Path (Join-Path $vendor "ProxiFyre.exe")) {
  Ok "FreeVPN should now show: 'Per-app routing engine ready.'"
} else {
  Warn "ProxiFyre.exe is not in $vendor yet - see the messages above."
}
Write-Host "  Next: start FreeVPN (as admin), tick 'VPN for chosen apps only', pick apps, connect."
Write-Host ""

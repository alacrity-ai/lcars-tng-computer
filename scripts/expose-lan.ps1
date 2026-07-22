# Exposes the TNG Computer wall (the WSL2 vite dev server on :5173) to the LAN
# so the TV-room PC can open it. One-time setup; survives WSL restarts.
#
# Run in an **elevated** (Run as administrator) PowerShell on the Windows host:
#   powershell -ExecutionPolicy Bypass -File scripts\expose-lan.ps1
# Undo:
#   powershell -ExecutionPolicy Bypass -File scripts\expose-lan.ps1 -Remove
#
# How it works: Windows listens on 0.0.0.0:5173 and forwards to 127.0.0.1:5173;
# WSL2's built-in localhost forwarding relays that into the WSL vm. Pinning the
# proxy to 127.0.0.1 (instead of the WSL vm's IP) is what makes it survive WSL
# restarts — the vm IP changes, localhost doesn't.
param([switch]$Remove)

$Port = 5173
$RuleName = "TNG Computer wall (:$Port)"

if ($Remove) {
  netsh interface portproxy delete v4tov4 listenport=$Port listenaddress=0.0.0.0 | Out-Null
  Remove-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue
  Write-Host "Removed portproxy and firewall rule for :$Port"
  exit 0
}

netsh interface portproxy add v4tov4 listenport=$Port listenaddress=0.0.0.0 connectport=$Port connectaddress=127.0.0.1 | Out-Null
if (-not (Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue)) {
  # Private profile only: home LAN yes, coffee-shop wifi no. If the TV can't
  # connect, check the network is marked Private (Settings > Network).
  New-NetFirewallRule -DisplayName $RuleName -Direction Inbound -Action Allow `
    -Protocol TCP -LocalPort $Port -Profile Private | Out-Null
}

Write-Host "Portproxy + firewall rule active for :$Port. Open the wall from the TV at:"
Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object {
    $_.IPAddress -notlike "127.*" -and
    $_.IPAddress -notlike "169.254.*" -and
    $_.InterfaceAlias -notlike "*WSL*" -and
    $_.InterfaceAlias -notlike "*Loopback*"
  } |
  ForEach-Object { Write-Host ("  http://{0}:{1}  ({2})" -f $_.IPAddress, $Port, $_.InterfaceAlias) }

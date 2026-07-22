# Exposes the TNG Computer wall (the WSL2 vite dev server on :5173) to the LAN
# so the TV-room PC can open it. One-time setup; survives WSL restarts.
#
# Run in an **elevated** (Run as administrator) PowerShell on the Windows host:
#   powershell -ExecutionPolicy Bypass -File scripts\expose-lan.ps1
# Undo:
#   powershell -ExecutionPolicy Bypass -File scripts\expose-lan.ps1 -Remove
#
# How it works: Windows listens on 0.0.0.0:5173 (IPv4) and forwards to
# [::1]:5173 — WSL2's localhost relay binds only the IPv6 loopback, so ::1 is
# the address that actually reaches the vm. Targeting ::1 (v4tov6) instead of
# the WSL vm's IP means it survives WSL restarts (the vm IP changes, ::1
# doesn't). NEVER target 127.0.0.1: the 0.0.0.0 listener covers IPv4 loopback,
# so a v4tov4 proxy to 127.0.0.1 forwards to *itself* in an infinite loop
# (symptom: ERR_EMPTY_RESPONSE + thousands of churning loopback connections).
param([switch]$Remove)

$Port = 5173
$RuleName = "TNG Computer wall (:$Port)"

if ($Remove) {
  netsh interface portproxy delete v4tov6 listenport=$Port listenaddress=0.0.0.0 | Out-Null
  netsh interface portproxy delete v4tov4 listenport=$Port listenaddress=0.0.0.0 | Out-Null
  Remove-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue
  Write-Host "Removed portproxy and firewall rule for :$Port"
  exit 0
}

# Clear any stale v4tov4 rule (the self-loop variant) before adding the good one.
netsh interface portproxy delete v4tov4 listenport=$Port listenaddress=0.0.0.0 2>$null | Out-Null
netsh interface portproxy add v4tov6 listenport=$Port listenaddress=0.0.0.0 connectport=$Port connectaddress=::1 | Out-Null
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

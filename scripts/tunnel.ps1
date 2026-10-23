# Starts or stops one Cloudflare tunnel connector in the background (Windows only).
param(
  [Parameter(Mandatory)][ValidateSet('start', 'stop')][string]$Action,
  [Parameter(Mandatory)][string]$Tunnel
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$config = Join-Path $root 'cloudflared.yml'
$log = Join-Path $root 'cloudflared.log'

# Finds the connector by its command line, so other tunnels on this machine are left alone.
function Get-Connector {
  $pattern = '\srun\s' + [regex]::Escape($Tunnel) + '$'
  @(Get-CimInstance Win32_Process -Filter "Name = 'cloudflared.exe'" | Where-Object { ([string]$_.CommandLine).TrimEnd() -match $pattern })
}

if ($Action -eq 'stop') {
  $connectors = Get-Connector
  if ($connectors.Count -eq 0) {
    Write-Output "Tunnel $Tunnel is not running."
    exit 0
  }
  $connectors | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Write-Output "Tunnel $Tunnel stopped."
  exit 0
}

if ((Get-Connector).Count -gt 0) {
  Write-Output "Tunnel $Tunnel is already running."
  exit 0
}

# A missing tunnel only prints to stderr, which the log does not keep, so check it here.
$info = cmd /c "cloudflared tunnel --config `"$config`" info $Tunnel 2>&1"
if ($LASTEXITCODE -ne 0) { throw "Tunnel $Tunnel cannot be used. Run task tunnel:setup if it does not exist yet.`n$info" }

# A new log for each start, so a line from an earlier run cannot count as a connection.
Remove-Item $log -ErrorAction SilentlyContinue
$arguments = "tunnel --config `"$config`" --logfile `"$log`" run $Tunnel"
$process = Start-Process -FilePath cloudflared -ArgumentList $arguments -WorkingDirectory $root -WindowStyle Hidden -PassThru
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline -and -not $process.HasExited) {
  if ((Test-Path $log) -and (Select-String -Path $log -Pattern 'Registered tunnel connection' -Quiet)) {
    Write-Output "Tunnel $Tunnel is running (process $($process.Id)). Log: $log"
    exit 0
  }
  Start-Sleep -Seconds 1
}
Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
if (Test-Path $log) { Get-Content $log -Tail 20 }
throw "Tunnel $Tunnel did not connect."

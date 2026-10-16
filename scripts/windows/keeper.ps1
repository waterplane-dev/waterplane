# Holds the host running inside WSL: started hidden by the Windows launcher's `start`
# (`packages/host/src/cli/windows.ts` — `node scripts/windows/host.mjs start` in a checkout,
# `<slug> start` for an npm install).
# PowerShell, not Node, so nothing on the Windows side keeps node.exe busy while the host runs
# (a Node upgrade replaces it in place). Holding wsl.exe is also what keeps the distro and its VM
# up. A crash, or WSL going away under it, is restarted with a growing pause; `stop` writes the
# stop flag first, and the keeper then exits instead.
#
# -Ensure is the autostart task's mode (the launcher's `autostart`): it fires at logon, on wake, on unlock
# and every 10 minutes, so it must be a no-op whenever the host is meant to be down (stop flag), is
# already answering, or has a keeper bringing it up — a second keeper would start a second daemon.
param(
  [Parameter(Mandatory)] [string] $Repo,      # the install as WSL sees it, /mnt/c/...
  [Parameter(Mandatory)] [string] $Log,
  [Parameter(Mandatory)] [string] $StopFlag,
  [Parameter(Mandatory)] [int] $Port,
  [string] $Distro = "",
  [string] $EnvPrefix = "",
  [switch] $Ensure
)
$ErrorActionPreference = "Continue"
$wslArgs = @()
if ($Distro) { $wslArgs += @("-d", $Distro) }
# `exec`: the daemon replaces bash, so the SIGTERM `stop` sends reaches it and nothing else.
# `2>&1` INSIDE Linux: wsl.exe writes stdout and stderr to a redirected file each from its own
# offset, so the two overwrote each other and the log kept stderr alone ("listening …" was lost).
# main.js by its ABSOLUTE path: `stop` falls back to matching this install's command line, and a
# relative `node packages/host/dist/main.js` is every install's in the distro.
$main = ("$Repo/packages/host/dist/main.js" -replace "'", "'\''")
$wslArgs += @("--cd", $Repo, "--exec", "bash", "-lc", "${EnvPrefix}exec node '$main' 2>&1")

function Test-Up {
  try { (Invoke-WebRequest "http://127.0.0.1:$Port/api/health" -TimeoutSec 3 -UseBasicParsing).StatusCode -eq 200 } catch { $false }
}

if ($Ensure) {
  if (Test-Path $StopFlag) { exit 0 }
  if (Test-Up) { exit 0 }
  # `-Repo "<this install>"` exactly, escaped: a bare `*$Repo*` let /mnt/c/dev/app match the keeper
  # of /mnt/c/dev/app-peer, and `[` `]` in a path are wildcards.
  $mine = '*-Repo "' + [WildcardPattern]::Escape($Repo) + '"*'
  $others = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
    Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*keeper.ps1*' -and $_.CommandLine -like $mine }
  if ($others) { exit 0 }
  Add-Content -Path $Log -Value "---- $(Get-Date -Format o) autostart: host not answering and no keeper running"
}

$pause = 2
while ($true) {
  Add-Content -Path $Log -Value "---- $(Get-Date -Format o) starting in WSL"
  $began = Get-Date
  # Through cmd for the append redirect: the daemon writes the log as it runs, and every restart adds to it.
  $cmd = "wsl.exe " + (($wslArgs | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }) -join " ") + " >> `"$Log`" 2>&1"
  & cmd.exe /d /c $cmd
  if (Test-Path $StopFlag) { exit 0 }
  if (((Get-Date) - $began).TotalSeconds -gt 120) { $pause = 2 }   # it ran a while: a fresh failure, not a boot loop
  Start-Sleep -Seconds $pause
  $pause = [Math]::Min($pause * 2, 60)
  if ((Test-Path $StopFlag) -or (Test-Up)) { exit 0 }           # stopped, or another start won
}

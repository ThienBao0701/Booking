# 13 — Windows Service Setup

The local service (`windows-service/`) is a Node.js process that binds to
`127.0.0.1` only. Crash recovery is provided by the bundled **watchdog**
(restart with exponential backoff, single-instance lock). Start-at-logon is
provided by **Windows Task Scheduler** until the Phase 15 installer registers a
proper Windows service.

> Status: the service, watchdog and entry points are covered by CI on Linux,
> including a regression test for Windows-style entry-point detection. The
> PowerShell below has **not** been executed by CI (no Windows runner yet);
> verify it on your machine with the checks at the end.

## 1. Prerequisites

- Node.js 22 (`winget install OpenJS.NodeJS.LTS`, then `node -v` ≥ 22.6).
- The repository checked out, e.g. `C:\lab\browser-automation-lab`, and
  `pnpm install` run once.
- Run everything as **your own user** (the data and token live in your
  profile; no administrator rights are needed).

## 2. Try it in the foreground

```powershell
cd C:\lab\browser-automation-lab
$env:LAB_DATA_DIR = "$env:LOCALAPPDATA\BrowserAutomationLab"
node --experimental-strip-types --experimental-sqlite windows-service\src\watchdog.ts
# in another terminal:
Invoke-RestMethod http://127.0.0.1:4577/healthz
Get-Content "$env:LOCALAPPDATA\BrowserAutomationLab\auth-token.txt"   # pairing token
```

Stop with `Ctrl+C`.

## 3. Start automatically at logon (Task Scheduler)

```powershell
$repo    = "C:\lab\browser-automation-lab"
$dataDir = "$env:LOCALAPPDATA\BrowserAutomationLab"
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
[Environment]::SetEnvironmentVariable("LAB_DATA_DIR", $dataDir, "User")

$node     = (Get-Command node).Source
$argsLine = "--experimental-strip-types --experimental-sqlite `"$repo\windows-service\src\watchdog.ts`""
$action   = New-ScheduledTaskAction -Execute $node -Argument $argsLine -WorkingDirectory $repo
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
              -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
              -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName "BrowserAutomationLab" -Action $action -Trigger $trigger `
  -Settings $settings -Description "Browser Automation Lab local service (127.0.0.1 only)"
Start-ScheduledTask -TaskName "BrowserAutomationLab"
```

Two layers of recovery:

- **Task Scheduler** starts the watchdog at logon and restarts it if it exits;
- the **watchdog** restarts the service process after a crash (1 s → 30 s
  backoff, reset after 10 s of healthy uptime) and refuses to run twice
  (`watchdog.lock`; a stale lock from a dead process is taken over).

Data survives crashes and restarts (SQLite WAL); the extension keeps queued
events and redelivers them.

## 4. Verify

```powershell
Get-ScheduledTask -TaskName "BrowserAutomationLab" | Select-Object State
Invoke-RestMethod http://127.0.0.1:4577/healthz          # status: ok
Get-Content "$env:LOCALAPPDATA\BrowserAutomationLab\logs\service.log" -Tail 5
```

Then pair the extension ([doc 12](12-chrome-extension-setup.md)).

## Networking and security

- The service listens on `127.0.0.1:4577` only — no inbound firewall rule is
  needed or wanted. It refuses to start on any other interface.
- The token file is created in your profile (`%LOCALAPPDATA%`), protected by
  your user account's ACLs (POSIX file modes do not apply on Windows).
- Every API call except `/healthz` requires the token; web pages are rejected
  by Origin/Host validation. See [05 — Security model](05-security-model.md).

## Stop / uninstall

```powershell
Stop-ScheduledTask   -TaskName "BrowserAutomationLab"
Unregister-ScheduledTask -TaskName "BrowserAutomationLab" -Confirm:$false
# Windows does not terminate child processes with their parent: stop any
# remaining service process explicitly.
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like "*windows-service*src*index.ts*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId }
[Environment]::SetEnvironmentVariable("LAB_DATA_DIR", $null, "User")
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\BrowserAutomationLab"   # data, logs, token
```

## Known limitations (addressed by the Phase 15 installer)

- **Orphaned child on forced stop.** Ending the watchdog task does not end its
  service child on Windows; a new watchdog then sees port 4577 in use and backs
  off while the orphan keeps serving. Use the stop commands above. The
  installer will run the service under a Windows service wrapper with a job
  object so children stop together.
- **Per-user logon start**, not boot start before logon (the recorder only
  runs in your browser session, so this is usually what you want).
- Node.js must be installed separately; the installer will bundle it.

# Registers the Crypto Women blog watcher as a Windows scheduled task that runs
# AT STARTUP, whether or not a user is logged on. Uses LogonType S4U ("do not
# store password") so it works even for PIN-only / passwordless accounts and
# needs no password prompt. git push still works (it uses a token stored in
# Windows Credential Manager, not Windows network auth).
# Called elevated by install-autostart.bat. Prints clear diagnostics on failure.
$ErrorActionPreference = 'Stop'

$TaskName = 'CryptoWomen Blog Watcher'
$SiteDir  = 'D:\AI Projects\Crypto Women\crypto-women-site'
$Bat      = Join-Path $SiteDir 'scripts\watcher\start-watcher.bat'
$User     = "$env:USERDOMAIN\$env:USERNAME"

Write-Host "Task    : $TaskName"
Write-Host "Runs    : $Bat"
Write-Host "As user : $User  (logon type S4U - no password stored)"
Write-Host ''

if (-not (Test-Path $Bat)) {
  Write-Host "ERROR: start-watcher.bat not found at $Bat" -ForegroundColor Red
  exit 2
}

# Stop any existing watcher / running task instance before (re)installing.
# (Use the cmdlet, not `schtasks /End` — under ErrorActionPreference=Stop a
#  non-existent-task stderr line from schtasks would abort the whole script.)
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*blog-import.mjs*' } |
  ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }

$arg       = '/c "' + $Bat + '"'
$action    = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument $arg -WorkingDirectory $SiteDir
$trigger   = New-ScheduledTaskTrigger -AtStartup
# ExecutionTimeLimit 0 -> never auto-kill (default 3 days); restart on crash.
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartInterval (New-TimeSpan -Minutes 1) -RestartCount 3 `
    -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $User -LogonType S4U -RunLevel Limited

try {
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal -Force -ErrorAction Stop | Out-Null
}
catch {
  Write-Host ''
  Write-Host ("Register-ScheduledTask FAILED: " + $_.Exception.Message) -ForegroundColor Red
  Write-Host 'If this mentions a policy/privilege issue, your account may be blocked from' -ForegroundColor Yellow
  Write-Host '"Log on as a batch job". Otherwise re-run this as Administrator.' -ForegroundColor Yellow
  exit 4
}

Write-Host ("OK - '" + $TaskName + "' registered. Starts at every boot, no login, no password.") -ForegroundColor Green
Write-Host 'Starting it now...'
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 2
Write-Host ("Task state: " + (Get-ScheduledTask -TaskName $TaskName).State)
exit 0

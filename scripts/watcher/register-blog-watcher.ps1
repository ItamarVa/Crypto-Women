# Registers the Crypto Women blog watcher as a Windows scheduled task that runs
# AT STARTUP, whether or not a user is logged on (LogonType = Password).
# Requires elevation (called by install-autostart.bat as Administrator).
$ErrorActionPreference = 'Stop'

$TaskName = 'CryptoWomen Blog Watcher'
$SiteDir  = 'D:\AI Projects\Crypto Women\crypto-women-site'
$Bat      = Join-Path $SiteDir 'scripts\watcher\start-watcher.bat'
$User     = "$env:USERDOMAIN\$env:USERNAME"

if (-not (Test-Path $Bat)) { throw "start-watcher.bat not found at $Bat" }

$arg = '/c "' + $Bat + '"'
$action  = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument $arg -WorkingDirectory $SiteDir
$trigger = New-ScheduledTaskTrigger -AtStartup
# ExecutionTimeLimit = 0 -> never auto-kill (default is 3 days); restart on crash.
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartInterval (New-TimeSpan -Minutes 1) -RestartCount 3

Write-Host ''
Write-Host 'To run the watcher at startup without you logging in, Windows needs to'
Write-Host ('store your password for the task. Enter the Windows password for ' + $User + '.')
Write-Host '(It is handed straight to Windows Task Scheduler, not shown or saved anywhere else.)'
Write-Host ''
$cred = Get-Credential -UserName $User -Message 'Windows password for the boot-time watcher task'

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -RunLevel Limited -User $cred.UserName -Password $cred.GetNetworkCredential().Password -Force | Out-Null

Write-Host ''
Write-Host ("OK - '" + $TaskName + "' installed. It will start at every boot (no login needed).")
Write-Host 'Starting it now...'
Start-ScheduledTask -TaskName $TaskName
Write-Host 'Running.'

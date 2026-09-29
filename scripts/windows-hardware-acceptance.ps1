# Read-only diagnostics. Writes only its local report. Does not install, pair,
# print, stop processes/services, clear queues, change logging or contact a host.
[CmdletBinding()]
param(
    [ValidateRange(1,86400)][int]$ObserveSeconds = 10,
    [string]$InstallDirectory = (Join-Path $env:LOCALAPPDATA 'Programs\PrintGo'),
    [string]$ProductionPrinterName = '',
    [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\.tmp\windows-acceptance')
)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'PHYSICAL/WINDOWS VERIFICATION: PENDING. Windows is required.' }
$started = [DateTime]::UtcNow
$report = [ordered]@{
    schemaVersion = 1
    startedAtUtc = $started.ToString('o')
    physicalVerification = 'NOT VERIFIED: manual checklist required'
    observationRequestedSeconds = $ObserveSeconds
    sections = [ordered]@{}
}
$sections = $report.sections
$localState = Join-Path $env:LOCALAPPDATA 'PrintGo'
try {
    $osInfo = Get-CimInstance Win32_OperatingSystem
    $sections.windows = @{ status='READY'; version=$osInfo.Version; build=$osInfo.BuildNumber; logicalProcessors=[Environment]::ProcessorCount }
} catch { $sections.windows = @{status='NOT VERIFIED'} }
$sections.credentials = @{ present=(Test-Path (Join-Path $localState 'agent-credentials.dat')); protection='NOT VERIFIED: envelope not read or decrypted' }
$sections.executionJournal = @{ present=(Test-Path (Join-Path $localState 'active-print.json')); note='Never delete an unresolved journal.' }
try { $sections.spooler = @{ status=[string](Get-Service Spooler).Status } }
catch { $sections.spooler = @{status='NOT VERIFIED'} }
try {
    $printers = @(Get-CimInstance Win32_Printer)
    $index = 0
    $sections.printers = @($printers | ForEach-Object {
        $index++
        $queueCount = $null
        try { $queueCount = @(Get-PrintJob -PrinterName $_.Name -ErrorAction Stop).Count } catch { }
        # Do not export printer names, job documents, owners, ports or server names.
        @{ index=$index; windowsDefault=[bool]$_.Default; workOffline=[bool]$_.WorkOffline;
           printerStatus=[int]$_.PrinterStatus; detectedErrorState=[int]$_.DetectedErrorState;
           requestedProductionMatch=($ProductionPrinterName -ne '' -and $_.Name -eq $ProductionPrinterName);
           queuedJobs=$queueCount }
    })
    $sections.productionSelection = @{ status='NOT VERIFIED'; note='Confirm Admin production selection and driver readiness manually; Windows default is not production authority.' }
} catch { $sections.printers = @{status='NOT VERIFIED'} }
try {
    $status = Get-Content (Join-Path $localState 'agent-status.json') -Raw | ConvertFrom-Json
    $state = 'UNKNOWN'
    if (@('ONLINE','OFFLINE','UNPAIRED','ERROR') -contains $status.operationalState) { $state=$status.operationalState }
    $age = $null
    if ($null -ne $status.lastHeartbeatMs) { $age=([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [double]$status.lastHeartbeatMs)/1000 }
    $sections.agentStatus = @{state=$state; heartbeatAgeSeconds=$age; stale=($null -eq $age -or $age -gt 90 -or $age -lt 0)}
} catch { $sections.agentStatus = @{status='NOT VERIFIED'} }
$sections.binaries = @('PrintGo-Agent.exe','PrintGo-ControlCenter.exe','SumatraPDF.exe') | ForEach-Object {
    $file = Join-Path $InstallDirectory $_
    if (Test-Path $file) {
        try { @{name=$_; present=$true; bytes=(Get-Item $file).Length; sha256=(Get-FileHash $file -Algorithm SHA256).Hash; signatureStatus=[string](Get-AuthenticodeSignature $file).Status} }
        catch { @{name=$_; present=$true; status='NOT VERIFIED'} }
    } else { @{name=$_; present=$false; status='BLOCKED'} }
}
try {
    $run = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name PrintGoControlCenter).PrintGoControlCenter
    $protocol = (Get-Item 'HKCU:\Software\Classes\printgo\shell\open\command').GetValue('')
    $expectedExe = Join-Path $InstallDirectory 'PrintGo-ControlCenter.exe'
    $sections.registration = @{startupMatches=($run -eq ('"'+$expectedExe+'" --minimized')); protocolMatches=($protocol -eq ('"'+$expectedExe+'" "%1"'))}
} catch { $sections.registration = @{status='NOT VERIFIED'} }
try {
    $log = Get-WinEvent -ListLog 'Microsoft-Windows-PrintService/Operational'
    $events = @()
    if ($log.IsEnabled) {
        $events = @(Get-WinEvent -FilterHashtable @{LogName=$log.LogName; Id=307; StartTime=(Get-Date).AddHours(-24)} -MaxEvents 30 -ErrorAction SilentlyContinue | ForEach-Object {
            @{recordId=$_.RecordId; timeUtc=$_.TimeCreated.ToUniversalTime().ToString('o')}
        })
    }
    $sections.printEvents = @{enabled=$log.IsEnabled; events=$events; note='Event 307 is driver/spooler evidence; visually count physical sheets separately.'}
} catch { $sections.printEvents = @{status='NOT VERIFIED'} }
# Strict timing allowlist: no raw log lines, paths, identifiers or error messages.
try {
    $timings = @(Get-Content (Join-Path $localState 'daemon.log') -Tail 2000 | ForEach-Object {
        if ($_ -match 'PRINT_TIMING step=[a-zA-Z0-9_-]+ event=(preparation_start|submission_start|sumatra_start|spool_captured|adapter_return|spool_identity_persisted|completion_reported) atMs=(\d{13})(\s|$)') {
            @{event=$Matches[1]; atMs=[double]$Matches[2]}
        }
    })
    $sections.recentTimingLog = $timings
} catch { $sections.recentTimingLog = @{status='NOT VERIFIED'} }
# Snapshot process counts do not measure launches; record process-start events separately.
$subscription = $null
$sourceId = 'PrintGoAcceptance-' + [Guid]::NewGuid().ToString('N')
$launches = 0
$launchStatus = 'NOT VERIFIED'
$samples = New-Object System.Collections.Generic.List[object]
$watch = [Diagnostics.Stopwatch]::StartNew()
try {
    try {
        $subscription = Register-CimIndicationEvent -Query "SELECT * FROM Win32_ProcessStartTrace WHERE ProcessName = 'powershell.exe' OR ProcessName = 'pwsh.exe'" -SourceIdentifier $sourceId
        $launchStatus='READY'
    } catch { }
    do {
        $processes = @(Get-Process -Name PrintGo-Agent,PrintGo-ControlCenter,SumatraPDF,powershell,pwsh -ErrorAction SilentlyContinue)
        $samples.Add(@{atSeconds=$watch.Elapsed.TotalSeconds; processes=@($processes | ForEach-Object {
            @{name=$_.ProcessName; pid=$_.Id; cpuTotalSeconds=$_.CPU; workingSetBytes=$_.WorkingSet64; privateBytes=$_.PrivateMemorySize64; handles=$_.HandleCount}
        })})
        if ($subscription) {
            $pending=@(Get-Event -SourceIdentifier $sourceId -ErrorAction SilentlyContinue)
            $launches += $pending.Count
            $pending | Remove-Event
        }
        if ($watch.Elapsed.TotalSeconds -lt $ObserveSeconds) { Start-Sleep -Milliseconds ([int][Math]::Min(5000, ($ObserveSeconds-$watch.Elapsed.TotalSeconds)*1000)) }
    } while ($watch.Elapsed.TotalSeconds -lt $ObserveSeconds)
} finally {
    if ($subscription) {
        $pending=@(Get-Event -SourceIdentifier $sourceId -ErrorAction SilentlyContinue)
        $launches += $pending.Count
        $pending | Remove-Event
        Unregister-Event -SourceIdentifier $sourceId
    }
}
$report.observationActualSeconds = $watch.Elapsed.TotalSeconds
$sections.resources = @{samples=$samples.ToArray(); powershellStarts=$launches; launchCounterStatus=$launchStatus; note='Observer PowerShell is included in snapshots. CPU totals require per-PID deltas; short-lived processes can escape snapshots.'}
$report.finishedAtUtc = [DateTime]::UtcNow.ToString('o')
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$outFile = Join-Path $OutputDirectory ('acceptance-'+[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfff')+'.json')
$report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $outFile -Encoding UTF8
Write-Output ('Read-only evidence saved: '+$outFile)
Write-Output 'PHYSICAL/WINDOWS VERIFICATION: PENDING until the manual acceptance checklist is completed.'

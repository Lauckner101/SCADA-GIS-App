# run_sensors.ps1 - start one sensor process per device listed in a JSON file,
# all in parallel. Press Ctrl+C to stop them all.
#
# Usage:
#   .\run_sensors.ps1 [devices.json] [sensor-binary]
#
# If scripts are blocked on your machine, run it like this instead:
#   powershell -ExecutionPolicy Bypass -File .\run_sensors.ps1
#
# Defaults to devices.json and .\sensor.exe. Each device is started as:
#   .\sensor.exe --type <type> --lat <lat> --lon <lon> --bind <ip> --id <id> --voltage <voltage>
#
# The JSON file is a list of objects with at least these keys:
#   "id", "type", "ip", "lat", "lon"
# and optionally "voltage" (e.g. "138kV"). A device with no voltage is started
# without --voltage, so the sensor uses its own default (138kV).
#
# The sensors run in hidden windows, so everything they print is discarded.
# This script's own messages are not affected.

param(
    [string]$Devices = "devices.json",
    [string]$Sensor  = ".\sensor.exe"
)

if (-not (Test-Path -LiteralPath $Devices -PathType Leaf)) {
    [Console]::Error.WriteLine("Cannot find $Devices")
    exit 1
}
if (-not (Test-Path -LiteralPath $Sensor -PathType Leaf)) {
    [Console]::Error.WriteLine("Cannot find an executable sensor at $Sensor (pass its path as the second argument)")
    exit 1
}

$sensorPath = (Resolve-Path -LiteralPath $Sensor).Path

try {
    # Assign to a variable first: Windows PowerShell 5.1 emits a top-level JSON
    # array as ONE object when piped, which merges every device into one.
    $raw    = Get-Content -LiteralPath $Devices -Raw
    $parsed = ConvertFrom-Json -InputObject $raw
} catch {
    [Console]::Error.WriteLine("Could not parse ${Devices}: $($_.Exception.Message)")
    exit 1
}
$list = New-Object System.Collections.ArrayList
foreach ($item in $parsed) {
    if ($item.id) { [void]$list.Add($item) }
}

if ($list.Count -eq 0) {
    [Console]::Error.WriteLine("No devices found in $Devices")
    exit 1
}

# Wrap a value in quotes so ids with spaces survive as one argument.
function Q($v) { '"' + $v + '"' }

$procs = New-Object System.Collections.ArrayList
$info  = @{}   # process Id -> "id (ip)"

try {
    foreach ($d in $list) {
        $argList = @(
            "--type", (Q $d.type),
            "--lat",  (Q $d.lat),
            "--lon",  (Q $d.lon),
            "--bind", (Q $d.ip),
            "--id",   (Q $d.id)
        )
        # Only pass --voltage when the device has one; otherwise the sensor
        # would be given an empty value and simulate a 0 V line.
        if ($d.voltage) {
            $argList += @("--voltage", (Q $d.voltage))
        }
        $p = Start-Process -FilePath $sensorPath -ArgumentList $argList `
                           -WindowStyle Hidden -PassThru
        [void]$procs.Add($p)
        $info[$p.Id] = "$($d.id) ($($d.ip))"
    }

    # Give them a moment, then report any that died on startup (port in use, bad address, ...).
    Start-Sleep -Seconds 1
    $running = 0
    foreach ($p in $procs) {
        $p.Refresh()
        if ($p.HasExited) {
            [Console]::Error.WriteLine("$($info[$p.Id]) exited immediately (its output is silenced; run it by hand to see why)")
        } else {
            $running++
        }
    }
    Write-Host "$running of $($procs.Count) sensors running. Press Ctrl+C to stop."

    # Wait until Ctrl+C (or until every sensor has exited).
    while ($true) {
        $alive = @($procs | Where-Object { -not $_.HasExited })
        if ($alive.Count -eq 0) { break }
        Start-Sleep -Seconds 1
    }
}
finally {
    $alive = @($procs | Where-Object { -not $_.HasExited })
    if ($alive.Count -gt 0) {
        Write-Host ""
        Write-Host "Stopping $($alive.Count) sensors..."
        $alive | ForEach-Object {
            try { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue } catch {}
        }
    }
}
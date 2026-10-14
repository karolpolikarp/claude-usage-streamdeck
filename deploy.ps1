<#
.SYNOPSIS
    Installs the Claude Usage plugin into Stream Deck and restarts the app.

.DESCRIPTION
    Stream Deck only picks up plugin changes on restart, so this stops
    StreamDeck.exe, mirrors the .sdPlugin folder into the Plugins directory and
    starts the app again.

.PARAMETER NoRestart
    Copy the files but leave Stream Deck alone (changes apply on next restart).
#>
[CmdletBinding()]
param(
    [switch]$NoRestart
)

$ErrorActionPreference = 'Stop'

$pluginId  = 'com.karolp.claudelimits.sdPlugin'
$source    = Join-Path $PSScriptRoot $pluginId
$target    = Join-Path $env:APPDATA "Elgato\StreamDeck\Plugins\$pluginId"
$streamDeck = 'C:\Program Files\Elgato\StreamDeck\StreamDeck.exe'

if (-not (Test-Path $source)) { throw "Source not found: $source" }

# The plugin's only dependency is `ws`, and it is not committed.
if (-not (Test-Path (Join-Path $source 'node_modules'))) {
    Write-Host 'Installing plugin dependencies...'
    npm install --omit=dev --no-audit --no-fund --prefix $source
    if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }
}

$wasRunning = $false
if (-not $NoRestart) {
    $proc = Get-Process -Name 'StreamDeck' -ErrorAction SilentlyContinue
    if ($proc) {
        $wasRunning = $true
        Write-Host 'Stopping Stream Deck...'
        $proc | Stop-Process -Force
        Start-Sleep -Seconds 2
    }
}

Write-Host "Copying to $target"
# /MIR keeps the target identical to the source; the log and usage cache are plugin-generated.
robocopy $source $target /MIR /NFL /NDL /NJH /NJS /NP /XF plugin.log usage-cache.json | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed with exit code $LASTEXITCODE" }

if (-not $NoRestart) {
    if (Test-Path $streamDeck) {
        Write-Host 'Starting Stream Deck...'
        Start-Process $streamDeck
    } elseif ($wasRunning) {
        Write-Warning "StreamDeck.exe not found at $streamDeck - start it manually."
    }
}

Write-Host 'Done. Add the Claude keys from the "Claude" category in Stream Deck.'

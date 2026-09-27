<#
.SYNOPSIS
    Compatibility wrapper for the dependency-free CommonJS checker.
#>
param(
    [switch]$NoRemote,
    [switch]$CheckRemote,
    [string]$ProjectPath = (Get-Location).Path,
    [ValidateRange(1, 600)][int]$CommandTimeoutSec = 20,
    [switch]$NoReport,
    [string]$ReportDirectory = (Join-Path $env:USERPROFILE ".claude\scripts")
)
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Write-Error "node is required for check-updates.js"; exit 127 }
$scriptPath = Join-Path $PSScriptRoot 'check-updates.js'
$nodeArgs = @($scriptPath, '--project-path', $ProjectPath, '--command-timeout-sec', [string]$CommandTimeoutSec, '--report-directory', $ReportDirectory)
if ($NoRemote) { $nodeArgs += '--no-remote' }
if ($NoReport) { $nodeArgs += '--no-report' }
& $node.Source @nodeArgs
exit $LASTEXITCODE
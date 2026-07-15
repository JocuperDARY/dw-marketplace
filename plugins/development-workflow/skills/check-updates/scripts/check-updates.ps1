<#
.SYNOPSIS
    Development Workflow environment update and health checker.
.DESCRIPTION
    Checks Claude Code, MCP servers, skills, CodeGraph, OpenSpec, and Codex.
    Default mode includes npm registry checks. Use -NoRemote for local-only checks.
.NOTES
    This script intentionally never prints env values, tokens, API keys, or auth files.
#>

param(
    [switch]$NoRemote,
    # Backward-compatible no-op: remote checks are now enabled by default.
    [switch]$CheckRemote,
    [string]$ProjectPath = (Get-Location).Path,
    [ValidateRange(1, 600)]
    [int]$CommandTimeoutSec = 20,
    [switch]$NoReport,
    [string]$ReportDirectory = (Join-Path $env:USERPROFILE ".claude\scripts")
)

$script:Report = @()
$script:HasUpdate = $false
$script:HasError = $false
$script:HasWarn = $false
$Separator = "=" * 78

function Write-Section {
    param([string]$Title)
    Write-Host ""
    Write-Host $Separator -ForegroundColor Cyan
    Write-Host ("  {0}" -f $Title) -ForegroundColor Cyan
    Write-Host $Separator -ForegroundColor Cyan
}

function Add-Status {
    param(
        [string]$Category,
        [string]$Name,
        [ValidateSet("OK", "UPDATE", "WARN", "INFO", "MISSING", "ERROR")]
        [string]$Status,
        [string]$Detail,
        [hashtable]$Data = @{}
    )

    $icon = switch ($Status) {
        "OK"      { "[OK]" }
        "UPDATE"  { "[UP]" }
        "WARN"    { "[!!]" }
        "INFO"    { "[..]" }
        "MISSING" { "[--]" }
        "ERROR"   { "[ER]" }
    }

    Write-Host ("  {0,-5} {1,-38} {2}" -f $icon, $Name, $Detail)

    $entry = [ordered]@{
        Category  = $Category
        Component = $Name
        Status    = $Status
        Detail    = $Detail
    }
    foreach ($key in $Data.Keys) {
        $entry[$key] = $Data[$key]
    }
    $script:Report += [PSCustomObject]$entry

    if ($Status -eq "UPDATE") { $script:HasUpdate = $true }
    if ($Status -eq "ERROR") { $script:HasError = $true }
    if ($Status -eq "WARN") { $script:HasWarn = $true }
}

function Read-JsonFile {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    try {
        return Get-Content -Raw -Encoding UTF8 -LiteralPath $Path | ConvertFrom-Json
    } catch {
        return $null
    }
}

function Get-CommandSource {
    param([string]$Name)
    $commands = @(Get-Command $Name -All -ErrorAction SilentlyContinue)
    $cmd = $commands | Where-Object { $_.CommandType -eq "Application" } | Select-Object -First 1
    if (-not $cmd) { $cmd = $commands | Select-Object -First 1 }
    if ($cmd) { return $cmd.Source }
    return $null
}

function Test-IsWindows {
    return [System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT
}

function Get-WindowsProcessSnapshot {
    if (-not ([System.Management.Automation.PSTypeName]'DevelopmentWorkflow.NativeProcessSnapshot').Type) {
        Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace DevelopmentWorkflow
{
    public static class NativeProcessSnapshot
    {
        private const uint TH32CS_SNAPPROCESS = 0x00000002;
        private static readonly IntPtr InvalidHandle = new IntPtr(-1);

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct ProcessEntry
        {
            public uint Size;
            public uint Usage;
            public uint ProcessId;
            public IntPtr DefaultHeapId;
            public uint ModuleId;
            public uint ThreadCount;
            public uint ParentProcessId;
            public int BasePriority;
            public uint Flags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
            public string ExecutableName;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool Process32First(IntPtr snapshot, ref ProcessEntry entry);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool Process32Next(IntPtr snapshot, ref ProcessEntry entry);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

        public static int[][] Capture()
        {
            var rows = new List<int[]>();
            IntPtr snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if (snapshot == InvalidHandle) return rows.ToArray();

            try
            {
                var entry = new ProcessEntry();
                entry.Size = (uint)Marshal.SizeOf(typeof(ProcessEntry));
                if (!Process32First(snapshot, ref entry)) return rows.ToArray();
                do
                {
                    rows.Add(new[] { (int)entry.ProcessId, (int)entry.ParentProcessId });
                    entry.Size = (uint)Marshal.SizeOf(typeof(ProcessEntry));
                }
                while (Process32Next(snapshot, ref entry));
            }
            finally
            {
                CloseHandle(snapshot);
            }

            return rows.ToArray();
        }
    }
}
'@ -ErrorAction Stop
    }

    foreach ($row in [DevelopmentWorkflow.NativeProcessSnapshot]::Capture()) {
        Write-Output -NoEnumerate $row
    }
}

function Get-OwnedDescendantProcessIds {
    param(
        [int]$RootProcessId,
        [DateTime]$NotBeforeUtc,
        [int]$BudgetSec = 4
    )
    if (-not (Test-IsWindows)) { return @() }

    $childrenByParent = @{}
    try {
        $snapshot = @(Get-WindowsProcessSnapshot)
    } catch {
        $snapshot = @(Get-CimInstance Win32_Process -OperationTimeoutSec 2 -ErrorAction SilentlyContinue | ForEach-Object {
            ,@([int]$_.ProcessId, [int]$_.ParentProcessId)
        })
    }
    foreach ($row in $snapshot) {
        if (-not $row -or $row.Count -lt 2) { continue }
        $childId = [int]$row[0]
        $parentId = [int]$row[1]
        if (-not $childrenByParent.ContainsKey($parentId)) {
            $childrenByParent[$parentId] = New-Object 'System.Collections.Generic.List[int]'
        }
        $childrenByParent[$parentId].Add($childId)
    }

    $pending = New-Object 'System.Collections.Generic.Stack[int]'
    $descendants = New-Object 'System.Collections.Generic.List[int]'
    $seen = New-Object 'System.Collections.Generic.HashSet[int]'
    $deadline = [DateTime]::UtcNow.AddSeconds($BudgetSec)
    $pending.Push($RootProcessId)
    [void]$seen.Add($RootProcessId)

    while ($pending.Count -gt 0 -and [DateTime]::UtcNow -lt $deadline) {
        $parentId = $pending.Pop()
        $children = $childrenByParent[$parentId]
        if (-not $children) { continue }
        foreach ($childId in $children) {
            $childId = [int]$childId
            if (-not $seen.Add($childId)) { continue }

            $createdUtc = $null
            try {
                $createdUtc = (Get-Process -Id $childId -ErrorAction Stop).StartTime.ToUniversalTime()
            } catch {}
            if ($createdUtc -and $createdUtc -lt $NotBeforeUtc.AddSeconds(-2)) { continue }

            $descendants.Add($childId)
            $pending.Push($childId)
        }
    }
    return $descendants.ToArray()
}

function Stop-OwnedProcessTree {
    param([System.Diagnostics.Process]$Process)
    if (-not $Process) { return }

    $rootId = $Process.Id
    $notBeforeUtc = [DateTime]::UtcNow.AddMinutes(-1)
    try { $notBeforeUtc = $Process.StartTime.ToUniversalTime() } catch {}
    $owned = New-Object 'System.Collections.Generic.List[int]'
    $ownedSeen = New-Object 'System.Collections.Generic.HashSet[int]'

    foreach ($childId in @(Get-OwnedDescendantProcessIds $rootId $notBeforeUtc)) {
        if ($ownedSeen.Add([int]$childId)) { $owned.Add([int]$childId) }
    }

    $rootRunning = $false
    try { $rootRunning = -not $Process.HasExited } catch {}
    if ($rootRunning) {
        try {
            $Process.Kill($true)
            [void]$Process.WaitForExit(2000)
        } catch {
            Stop-Process -Id $rootId -Force -ErrorAction SilentlyContinue
        }
        # A child can be spawned between the first snapshot and root termination.
        foreach ($childId in @(Get-OwnedDescendantProcessIds $rootId $notBeforeUtc)) {
            if ($ownedSeen.Add([int]$childId)) { $owned.Add([int]$childId) }
        }
    }
    for ($i = $owned.Count - 1; $i -ge 0; $i--) {
        Stop-Process -Id $owned[$i] -Force -ErrorAction SilentlyContinue
    }
    Stop-Process -Id $rootId -Force -ErrorAction SilentlyContinue

    $remaining = New-Object 'System.Collections.Generic.List[int]'
    foreach ($childId in $owned) {
        try {
            $childProcess = Get-Process -Id $childId -ErrorAction Stop
            if (-not $childProcess.WaitForExit(1000)) { $remaining.Add($childId) }
        } catch {}
    }
    if ($remaining.Count -gt 0) {
        Write-Warning "Owned child processes may still be running: $($remaining -join ', ')"
    }
    try {
        if (-not $Process.HasExited -and -not $Process.WaitForExit(1000)) {
            Write-Warning "Owned process $rootId may still be running"
        }
    } catch {}
}

function Invoke-ExternalCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [string[]]$Arguments = @(),
        [int]$TimeoutSec = $CommandTimeoutSec
    )

    $source = Get-CommandSource $Name
    if (-not $source) {
        return [PSCustomObject]@{
            ExitCode = $null
            StdOut = ""
            StdErr = "$Name not found on PATH"
            TimedOut = $false
            Started = $false
        }
    }

    $process = $null
    $stdoutTask = $null
    $stderrTask = $null
    try {
        $startFile = $source
        $quotedArguments = @($Arguments | ForEach-Object {
            '"' + ([string]$_ -replace '"', '\"') + '"'
        })
        $startArguments = $quotedArguments -join ' '
        if ((Test-IsWindows) -and [System.IO.Path]::GetExtension($source) -match '^\.(cmd|bat)$') {
            $batchArguments = @($Arguments | ForEach-Object {
                $value = [string]$_
                if ($value -match '[\s"&|<>^()]') {
                    '"' + ($value -replace '"', '""') + '"'
                } else {
                    $value
                }
            })
            $commandLine = '"' + ($source -replace '"', '""') + '"'
            if ($batchArguments.Count -gt 0) {
                $commandLine += ' ' + ($batchArguments -join ' ')
            }
            $startFile = $env:ComSpec
            $startArguments = "/d /s /c call $commandLine"
        }

        $startInfo = New-Object System.Diagnostics.ProcessStartInfo
        $startInfo.FileName = $startFile
        $startInfo.Arguments = $startArguments
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError = $true
        $process = New-Object System.Diagnostics.Process
        $process.StartInfo = $startInfo
        if (-not $process.Start()) { throw "Failed to start $Name" }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()

        if (-not $process.WaitForExit($TimeoutSec * 1000)) {
            Stop-OwnedProcessTree $process
            try { [void]$process.WaitForExit(2000) } catch {}
            return [PSCustomObject]@{
                ExitCode = $null
                StdOut = ""
                StdErr = "$Name timed out after ${TimeoutSec}s"
                TimedOut = $true
                Started = $true
            }
        }

        $exitCode = $process.ExitCode
        $stdoutReady = $stdoutTask -and $stdoutTask.Wait(100)
        $stderrReady = $stderrTask -and $stderrTask.Wait(100)
        if (-not ($stdoutReady -and $stderrReady)) {
            Stop-OwnedProcessTree $process
        }
        $stdout = if (($stdoutReady -or ($stdoutTask -and $stdoutTask.Wait(2000))) -and -not $stdoutTask.IsFaulted) {
            $stdoutTask.Result
        } else { "" }
        $stderr = if (($stderrReady -or ($stderrTask -and $stderrTask.Wait(2000))) -and -not $stderrTask.IsFaulted) {
            $stderrTask.Result
        } else { "" }
        return [PSCustomObject]@{
            ExitCode = $exitCode
            StdOut = [string]$stdout
            StdErr = [string]$stderr
            TimedOut = $false
            Started = $true
        }
    } catch {
        return [PSCustomObject]@{
            ExitCode = $null
            StdOut = ""
            StdErr = $_.Exception.Message
            TimedOut = $false
            Started = $false
        }
    } finally {
        if ($process) { Stop-OwnedProcessTree $process }
        if ($process) { $process.Dispose() }
    }
}

function Get-CommandVersionText {
    param([string]$Name)
    if (-not (Get-CommandSource $Name)) { return $null }
    $result = Invoke-ExternalCommand $Name @("--version")
    if ($result.TimedOut -or -not $result.Started -or [string]::IsNullOrWhiteSpace($result.StdOut)) { return $null }
    $lines = ([string]$result.StdOut -split "`r?`n") | Select-Object -First 3
    return (($lines | ForEach-Object { "$_" }) -join " ").Trim()
}

function Normalize-Version {
    param([string]$Text)
    if (-not $Text) { return $null }
    $m = [regex]::Match($Text, '\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?')
    if ($m.Success) { return $m.Value }
    return $Text.Trim()
}

function Compare-VersionText {
    param([string]$A, [string]$B)
    try {
        return ([version](Normalize-Version $A)).CompareTo([version](Normalize-Version $B))
    } catch {
        return [string]::Compare((Normalize-Version $A), (Normalize-Version $B), $true)
    }
}

function Get-NpmGlobalDependencies {
    if (-not (Get-CommandSource "npm")) { return $null }
    try {
        $result = Invoke-ExternalCommand "npm" @("list", "-g", "--depth=0", "--json")
        if ($result.TimedOut -or -not $result.Started) { return $null }
        $raw = $result.StdOut
        if (-not $raw) { return $null }
        return ($raw | ConvertFrom-Json).dependencies
    } catch {
        return $null
    }
}

function Get-NpmPackageVersion {
    param([object]$Dependencies, [string]$PackageName)
    if (-not $Dependencies) { return $null }
    $prop = $Dependencies.PSObject.Properties | Where-Object { $_.Name -eq $PackageName } | Select-Object -First 1
    if ($prop -and $prop.Value -and $prop.Value.version) { return [string]$prop.Value.version }
    return $null
}

function Get-PipPackageVersion {
    param([string]$PackageName)
    $python = Get-CommandSource "python"
    if (-not $python) { return $null }
    try {
        $result = Invoke-ExternalCommand "python" @("-m", "pip", "show", $PackageName)
        if ($result.TimedOut -or -not $result.Started -or [string]::IsNullOrWhiteSpace($result.StdOut)) { return $null }
        foreach ($line in ([string]$result.StdOut -split "`r?`n")) {
            if ($line -match '^Version:\s*(.+)$') { return $Matches[1].Trim() }
        }
    } catch {
        return $null
    }
    return $null
}

function Get-ObjectProperty {
    param([object]$Object, [string]$Name)
    if (-not $Object) { return $null }
    $prop = $Object.PSObject.Properties[$Name]
    if ($prop) { return $prop.Value }
    return $null
}

function Get-ClaudeMcpServers {
    $servers = [ordered]@{}
    $paths = @(
        (Join-Path $env:USERPROFILE ".claude\settings.json"),
        (Join-Path $env:USERPROFILE ".claude\mcp-configs\mcp-servers.json")
    )

    foreach ($path in $paths) {
        $json = Read-JsonFile $path
        if (-not $json) { continue }
        $mcp = Get-ObjectProperty $json "mcpServers"
        if (-not $mcp) { $mcp = Get-ObjectProperty $json "mcp_servers" }
        if (-not $mcp) { continue }
        foreach ($prop in $mcp.PSObject.Properties) {
            $servers[$prop.Name] = $prop.Value
        }
    }
    return $servers
}

function Get-CodexMcpServerNames {
    $configPath = Join-Path $env:USERPROFILE ".codex\config.toml"
    $names = New-Object System.Collections.Generic.HashSet[string]
    if (-not (Test-Path -LiteralPath $configPath)) { return @() }
    try {
        foreach ($line in Get-Content -LiteralPath $configPath) {
            if ($line -match '^\s*\[mcp_servers\.([^\]]+)\]\s*$') {
                $name = $Matches[1] -replace '\.env$', ''
                [void]$names.Add($name)
            }
        }
    } catch {
        return @()
    }
    return @($names | Sort-Object)
}

function Find-McpServerMatch {
    param([object]$Servers, [string]$Pattern)
    if (-not $Servers) { return $false }
    foreach ($entry in $Servers.GetEnumerator()) {
        $name = $entry.Key
        $value = $entry.Value | ConvertTo-Json -Depth 4 -Compress
        if ($name -match $Pattern -or $value -match $Pattern) { return $true }
    }
    return $false
}

function Classify-McpServer {
    param([object]$Server)
    $command = [string](Get-ObjectProperty $Server "command")
    $argsObj = Get-ObjectProperty $Server "args"
    $args = if ($argsObj) { ($argsObj | ForEach-Object { "$_" }) -join " " } else { "" }
    if (-not $command) {
        $url = Get-ObjectProperty $Server "url"
        if ($url) { return "http/server-maintained" }
        return "configured/no-command"
    }
    $cmdLower = $command.ToLowerInvariant()
    $argLower = $args.ToLowerInvariant()
    if ($cmdLower -match 'npx|cmd' -and $argLower -match 'npx') { return "npx runtime" }
    if ($cmdLower -match 'uvx' -or $argLower -match 'uvx') { return "uvx runtime" }
    if ($cmdLower -match 'python|python3' -or $argLower -match 'python') { return "python package" }
    if ($cmdLower -match 'codegraph') { return "codegraph cli" }
    if ($cmdLower -match 'openspec' -or $argLower -match 'openspec') { return "openspec cli/mcp" }
    return $command
}

function Test-DirectoryCount {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    try {
        return @(Get-ChildItem -LiteralPath $Path -Directory -ErrorAction SilentlyContinue).Count
    } catch {
        return $null
    }
}

function Check-CliTool {
    param(
        [string]$Category,
        [string]$CommandName,
        [string]$DisplayName,
        [string]$NpmPackage,
        [object]$NpmDeps
    )

    $source = Get-CommandSource $CommandName
    $version = Get-CommandVersionText $CommandName
    if ($source -and $version) {
        Add-Status $Category $DisplayName "OK" ("{0} ({1})" -f (Normalize-Version $version), $source) @{
            command = $CommandName
            version = Normalize-Version $version
            source = $source
        }
    } elseif ($source) {
        Add-Status $Category $DisplayName "WARN" "found at $source, but version check failed or timed out"
    } else {
        Add-Status $Category $DisplayName "MISSING" "$CommandName not found on PATH"
    }

    if ($NpmPackage) {
        $npmVersion = Get-NpmPackageVersion $NpmDeps $NpmPackage
        if ($npmVersion) {
            Add-Status $Category "$NpmPackage package" "OK" "global npm v$npmVersion"
        } else {
            Add-Status $Category "$NpmPackage package" "INFO" "not found in npm global list"
        }
    }
}

function Check-RemoteNpmUpdates {
    param([string[]]$Packages)
    Write-Section "7. Remote npm update check"
    if ($NoRemote) {
        Add-Status "Remote" "npm outdated" "INFO" "skipped because -NoRemote was specified"
        return
    }
    if (-not (Get-CommandSource "npm")) {
        Add-Status "Remote" "npm outdated" "MISSING" "npm not found"
        return
    }

    try {
        $result = Invoke-ExternalCommand "npm" @("outdated", "-g", "--json")
        if ($result.TimedOut) {
            Add-Status "Remote" "npm outdated" "WARN" $result.StdErr
            return
        }
        if (-not $result.Started) {
            Add-Status "Remote" "npm outdated" "WARN" $result.StdErr
            return
        }
        $text = ([string]$result.StdOut).Trim()
        $exitFailed = (($null -ne $result.ExitCode) -and ([int]$result.ExitCode -ne 0))
        $hasStdErr = -not [string]::IsNullOrWhiteSpace([string]$result.StdErr)
        $registryFailed = $exitFailed -or $hasStdErr
        if (-not $text) {
            if ($registryFailed) {
                $exitDetail = if ($null -ne $result.ExitCode) {
                    "npm exited with code $($result.ExitCode)"
                } else {
                    "npm returned an error without an exit code"
                }
                Add-Status "Remote" "npm outdated" "WARN" "$exitDetail; check registry and network configuration"
                return
            }
            foreach ($pkg in $Packages) {
                $installed = Get-NpmPackageVersion $npmDeps $pkg
                if ($installed) {
                    Add-Status "Remote" $pkg "OK" "installed v$installed; not listed as outdated"
                } else {
                    Add-Status "Remote" $pkg "MISSING" "not installed globally"
                }
            }
            return
        }

        $parsed = $null
        try { $parsed = $text | ConvertFrom-Json } catch {
            Add-Status "Remote" "npm outdated" "WARN" "registry check returned non-JSON output"
            return
        }

        $errorObject = (Get-ObjectProperty $parsed "error")
        if (-not $errorObject) { $errorObject = (Get-ObjectProperty $parsed "errors") }
        $updates = @{}
        foreach ($pkg in $Packages) {
            $prop = $parsed.PSObject.Properties[$pkg]
            if ($prop -and $prop.Value -and $prop.Value.current -and $prop.Value.latest) {
                $updates[$pkg] = $prop.Value
            }
        }

        if ($errorObject -or ($exitFailed -and $updates.Count -eq 0)) {
            Add-Status "Remote" "npm outdated" "WARN" "registry returned an error or incomplete result"
            return
        }
        if ($hasStdErr) {
            Add-Status "Remote" "npm outdated" "WARN" "registry returned update data with warnings; absent packages are unconfirmed"
        }

        foreach ($pkg in $Packages) {
            if ($updates.ContainsKey($pkg)) {
                $item = $updates[$pkg]
                Add-Status "Remote" $pkg "UPDATE" ("{0} -> {1}" -f $item.current, $item.latest) @{
                    current = $item.current
                    latest = $item.latest
                }
            } elseif ($hasStdErr) {
                Add-Status "Remote" $pkg "INFO" "update status not confirmed because registry warnings were returned"
            } else {
                $installed = Get-NpmPackageVersion $npmDeps $pkg
                if ($installed) {
                    Add-Status "Remote" $pkg "OK" "installed v$installed; not listed as outdated"
                } else {
                    Add-Status "Remote" $pkg "MISSING" "not installed globally"
                }
            }
        }
    } catch {
        Add-Status "Remote" "npm outdated" "WARN" $_.Exception.Message
    }
}

$npmDeps = Get-NpmGlobalDependencies
$claudeMcpServers = Get-ClaudeMcpServers
$codexMcpNames = Get-CodexMcpServerNames

Write-Section "1. Claude Code and plugins"
$claudeVersion = Get-CommandVersionText "claude"
if ($claudeVersion) {
    Add-Status "Claude" "Claude Code CLI" "OK" $claudeVersion
} else {
    Add-Status "Claude" "Claude Code CLI" "MISSING" "claude not found on PATH"
}

$settingsPath = Join-Path $env:USERPROFILE ".claude\settings.json"
$settings = Read-JsonFile $settingsPath
if ($settings) {
    $enabled = Get-ObjectProperty $settings "enabledPlugins"
    $enabledCount = if ($enabled) { @($enabled.PSObject.Properties).Count } else { 0 }
    Add-Status "Claude" "enabledPlugins" "INFO" "$enabledCount configured"
} else {
    Add-Status "Claude" "settings.json" "WARN" "not found or invalid JSON"
}

$pluginCache = Join-Path $env:USERPROFILE ".claude\plugins\cache"
$pluginCount = Test-DirectoryCount $pluginCache
if ($null -ne $pluginCount) {
    Add-Status "Claude" "plugin cache" "INFO" "$pluginCount marketplace cache directories"
} else {
    Add-Status "Claude" "plugin cache" "INFO" "not found"
}

Write-Section "2. MCP servers"
$mcpCount = $claudeMcpServers.Count
if ($mcpCount -gt 0) {
    Add-Status "MCP" "Claude MCP servers" "OK" "$mcpCount configured"
    foreach ($entry in $claudeMcpServers.GetEnumerator() | Sort-Object Name) {
        Add-Status "MCP" $entry.Key "INFO" (Classify-McpServer $entry.Value)
    }
} else {
    Add-Status "MCP" "Claude MCP servers" "WARN" "none found in settings or mcp-configs"
}

Write-Section "3. CodeGraph"
Check-CliTool "CodeGraph" "codegraph" "CodeGraph CLI" "@colbymchenry/codegraph" $npmDeps

$codegraphClaude = Find-McpServerMatch $claudeMcpServers 'codegraph'
if ($codegraphClaude) {
    Add-Status "CodeGraph" "Claude MCP registration" "OK" "codegraph configured"
} else {
    Add-Status "CodeGraph" "Claude MCP registration" "WARN" "codegraph not found in Claude MCP config"
}

if ($codexMcpNames -contains "codegraph") {
    Add-Status "CodeGraph" "Codex MCP registration" "OK" "codegraph configured"
} else {
    Add-Status "CodeGraph" "Codex MCP registration" "INFO" "not registered in Codex config"
}

$projectCodegraph = Join-Path $ProjectPath ".codegraph"
if (Test-Path -LiteralPath $projectCodegraph) {
    Add-Status "CodeGraph" "project index" "OK" ".codegraph exists in project"
} else {
    Add-Status "CodeGraph" "project index" "INFO" "current project is not indexed; use grep/read or run codegraph init manually if desired"
}

$globalCodegraph = Join-Path $env:USERPROFILE ".claude\.codegraph"
if (Test-Path -LiteralPath $globalCodegraph) {
    Add-Status "CodeGraph" "global index directory" "OK" $globalCodegraph
} else {
    Add-Status "CodeGraph" "global index directory" "INFO" "not found"
}

Write-Section "4. OpenSpec"
Check-CliTool "OpenSpec" "openspec" "OpenSpec CLI" "@fission-ai/openspec" $npmDeps

$openspecProject = Join-Path $ProjectPath "openspec"
if (Test-Path -LiteralPath $openspecProject) {
    $specCount = Test-DirectoryCount (Join-Path $openspecProject "specs")
    $changeCount = Test-DirectoryCount (Join-Path $openspecProject "changes")
    if ($null -eq $specCount) { $specCount = 0 }
    if ($null -eq $changeCount) { $changeCount = 0 }
    Add-Status "OpenSpec" "project directory" "OK" ("openspec/ exists; specs={0}, changes={1}" -f $specCount, $changeCount)
} else {
    Add-Status "OpenSpec" "project directory" "INFO" "current project has no openspec/ directory"
}

$openspecMcp = Get-PipPackageVersion "openspec-mcp"
if ($openspecMcp) {
    Add-Status "OpenSpec" "openspec-mcp" "OK" "pip package v$openspecMcp"
} else {
    Add-Status "OpenSpec" "openspec-mcp" "INFO" "pip package not found"
}

$openspecClaude = Find-McpServerMatch $claudeMcpServers 'openspec'
if ($openspecClaude) {
    Add-Status "OpenSpec" "Claude MCP registration" "OK" "openspec configured"
} else {
    Add-Status "OpenSpec" "Claude MCP registration" "INFO" "not registered in Claude MCP config"
}

if ($codexMcpNames -match 'openspec') {
    Add-Status "OpenSpec" "Codex MCP registration" "OK" "openspec configured"
} else {
    Add-Status "OpenSpec" "Codex MCP registration" "INFO" "not registered in Codex config"
}

Write-Section "5. Codex"
Check-CliTool "Codex" "codex" "Codex CLI" "@openai/codex" $npmDeps

$codexConfig = Join-Path $env:USERPROFILE ".codex\config.toml"
if (Test-Path -LiteralPath $codexConfig) {
    Add-Status "Codex" "config.toml" "OK" "exists; sensitive values not printed"
} else {
    Add-Status "Codex" "config.toml" "WARN" "not found"
}

$codexVersionJsonPath = Join-Path $env:USERPROFILE ".codex\version.json"
$codexVersionJson = Read-JsonFile $codexVersionJsonPath
if ($codexVersionJson) {
    $installed = Normalize-Version (Get-CommandVersionText "codex")
    $latest = [string](Get-ObjectProperty $codexVersionJson "latest_version")
    $lastChecked = [string](Get-ObjectProperty $codexVersionJson "last_checked_at")
    if ($installed -and $latest) {
        if ((Compare-VersionText $installed $latest) -lt 0) {
            Add-Status "Codex" "version cache" "UPDATE" ("installed {0}; cached latest {1}" -f $installed, $latest)
        } else {
            Add-Status "Codex" "version cache" "OK" ("installed {0}; cached latest {1}" -f $installed, $latest)
        }
    } else {
        Add-Status "Codex" "version cache" "INFO" "version.json exists"
    }
    if ($lastChecked) {
        try {
            $age = [datetime]::UtcNow - ([datetime]::Parse($lastChecked).ToUniversalTime())
            if ($age.TotalDays -gt 7) {
                Add-Status "Codex" "version cache age" "WARN" ("last checked {0:N1} days ago" -f $age.TotalDays)
            } else {
                Add-Status "Codex" "version cache age" "OK" ("last checked {0:N1} days ago" -f $age.TotalDays)
            }
        } catch {
            Add-Status "Codex" "version cache age" "INFO" "last_checked_at could not be parsed"
        }
    }
} else {
    Add-Status "Codex" "version.json" "INFO" "not found"
}

if ($codexMcpNames.Count -gt 0) {
    Add-Status "Codex" "MCP servers" "OK" (($codexMcpNames -join ", "))
} else {
    Add-Status "Codex" "MCP servers" "INFO" "none configured"
}

$codexSkills = Test-DirectoryCount (Join-Path $env:USERPROFILE ".codex\skills")
if ($null -ne $codexSkills) {
    Add-Status "Codex" "skills" "INFO" "$codexSkills installed"
} else {
    Add-Status "Codex" "skills" "INFO" "skills directory not found"
}

$codexRules = Test-DirectoryCount (Join-Path $env:USERPROFILE ".codex\rules")
if ($null -ne $codexRules) {
    Add-Status "Codex" "rules" "INFO" "$codexRules installed"
}

Write-Section "6. Skills"
$ccSwitchSkills = Test-DirectoryCount (Join-Path $env:USERPROFILE ".cc-switch\skills")
if ($null -ne $ccSwitchSkills) {
    Add-Status "Skills" "CC Switch skills" "INFO" "$ccSwitchSkills installed; update via CC Switch workflow"
} else {
    Add-Status "Skills" "CC Switch skills" "INFO" "not found"
}

$claudeSkills = Test-DirectoryCount (Join-Path $env:USERPROFILE ".claude\skills")
if ($null -ne $claudeSkills) {
    Add-Status "Skills" "Claude local skills" "INFO" "$claudeSkills installed"
} else {
    Add-Status "Skills" "Claude local skills" "INFO" "not found"
}

if ($null -ne $codexSkills) {
    Add-Status "Skills" "Codex skills" "INFO" "$codexSkills installed"
}

Check-RemoteNpmUpdates @("@colbymchenry/codegraph", "@fission-ai/openspec", "@openai/codex")

$summary = [ordered]@{
    generated_at = (Get-Date).ToString("o")
    project_path = $ProjectPath
    check_remote = -not [bool]$NoRemote
    no_remote = [bool]$NoRemote
    has_update = $script:HasUpdate
    has_warn = $script:HasWarn
    has_error = $script:HasError
    item_count = $script:Report.Count
}

$reportMessage = "Report file skipped because -NoReport was specified"
if ($NoReport) {
    $reportMessage = "Report file skipped because -NoReport was specified"
} else {
    try {
        if (-not (Test-Path -LiteralPath $ReportDirectory)) {
            New-Item -ItemType Directory -Path $ReportDirectory -Force | Out-Null
        }
        $reportPath = Join-Path $ReportDirectory ("update-report-{0}.json" -f (Get-Date).ToString("yyyyMMdd-HHmmss"))
        [PSCustomObject]@{
            summary = $summary
            items = $script:Report
        } | ConvertTo-Json -Depth 8 | Out-File -LiteralPath $reportPath -Encoding UTF8
        $reportMessage = "Report saved: $reportPath"
    } catch {
        Add-Status "Report" "write report" "WARN" $_.Exception.Message
        $summary.has_warn = $true
        $summary.item_count = $script:Report.Count
        $reportMessage = "Report was not saved"
    }
}

Write-Section "8. Summary"
if ($script:HasError) {
    Write-Host "  Errors found; inspect ERROR rows." -ForegroundColor Red
} elseif ($script:HasUpdate) {
    Write-Host "  Updates available." -ForegroundColor Yellow
} elseif ($script:HasWarn) {
    Write-Host "  No confirmed updates, but warnings need attention." -ForegroundColor Yellow
} else {
    Write-Host "  No confirmed updates in this check." -ForegroundColor Green
}

Write-Host ""
Write-Host "  Suggested commands:" -ForegroundColor Cyan
Write-Host "    CodeGraph: npm update -g @colbymchenry/codegraph"
Write-Host "    OpenSpec:  npm update -g @fission-ai/openspec"
Write-Host "    Codex:     npm update -g @openai/codex"
Write-Host "    Local-only: rerun this script with -NoRemote"
Write-Host ""
Write-Host "  $reportMessage"

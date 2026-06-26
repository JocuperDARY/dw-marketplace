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
    $cmd = Get-Command $Name -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}

function Get-CommandVersionText {
    param([string]$Name)
    if (-not (Get-CommandSource $Name)) { return $null }
    try {
        $output = & $Name --version 2>&1 | Select-Object -First 3
        return (($output | ForEach-Object { "$_" }) -join " ").Trim()
    } catch {
        return $null
    }
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
        $raw = npm list -g --depth=0 --json 2>$null
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
        $output = python -m pip show $PackageName 2>$null
        foreach ($line in $output) {
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
    if ($source) {
        Add-Status $Category $DisplayName "OK" ("{0} ({1})" -f (Normalize-Version $version), $source) @{
            command = $CommandName
            version = Normalize-Version $version
            source = $source
        }
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
        $raw = npm outdated -g --json 2>&1
        $text = (($raw | ForEach-Object { "$_" }) -join "`n").Trim()
        if (-not $text) {
            foreach ($pkg in $Packages) {
                Add-Status "Remote" $pkg "OK" "not listed as outdated"
            }
            return
        }

        $parsed = $null
        try { $parsed = $text | ConvertFrom-Json } catch {
            Add-Status "Remote" "npm outdated" "WARN" "registry check returned non-JSON output"
            return
        }

        foreach ($pkg in $Packages) {
            $prop = $parsed.PSObject.Properties[$pkg]
            if ($prop) {
                $item = $prop.Value
                Add-Status "Remote" $pkg "UPDATE" ("{0} -> {1}" -f $item.current, $item.latest) @{
                    current = $item.current
                    latest = $item.latest
                }
            } else {
                Add-Status "Remote" $pkg "OK" "not listed as outdated"
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

Write-Section "8. Summary"
if ($script:HasUpdate) {
    Write-Host "  Updates available." -ForegroundColor Yellow
} elseif ($script:HasError) {
    Write-Host "  Errors found; inspect ERROR rows." -ForegroundColor Red
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

try {
    if (-not (Test-Path -LiteralPath $ReportDirectory)) {
        New-Item -ItemType Directory -Path $ReportDirectory -Force | Out-Null
    }
    $reportPath = Join-Path $ReportDirectory ("update-report-{0}.json" -f (Get-Date).ToString("yyyyMMdd-HHmmss"))
    [PSCustomObject]@{
        summary = $summary
        items = $script:Report
    } | ConvertTo-Json -Depth 8 | Out-File -LiteralPath $reportPath -Encoding UTF8
    Write-Host ""
    Write-Host "  Report saved: $reportPath"
} catch {
    Add-Status "Report" "write report" "WARN" $_.Exception.Message
}

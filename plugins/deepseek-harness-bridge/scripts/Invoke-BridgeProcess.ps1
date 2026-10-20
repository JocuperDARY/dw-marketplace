# Dot-source to expose Invoke-BridgeProcess. No shell interpretation or output echo.
function ConvertTo-BridgeWindowsArgument {
    param([AllowEmptyString()][string]$Value)
    if ($Value.Length -eq 0) { return '""' }
    if ($Value -notmatch '[\s"]') { return $Value }
    $builder = New-Object System.Text.StringBuilder
    [void]$builder.Append('"')
    $slashes = 0
    foreach ($character in $Value.ToCharArray()) {
        if ($character -eq '\') { $slashes++; continue }
        if ($character -eq '"') {
            [void]$builder.Append('\' * (2 * $slashes + 1))
            [void]$builder.Append('"')
        } else {
            if ($slashes -gt 0) { [void]$builder.Append('\' * $slashes) }
            [void]$builder.Append($character)
        }
        $slashes = 0
    }
    if ($slashes -gt 0) { [void]$builder.Append('\' * (2 * $slashes)) }
    [void]$builder.Append('"')
    return $builder.ToString()
}

function Assert-BridgeDirectory {
    param([string]$Path)
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if (-not $item.PSIsContainer) { throw 'Bridge process directory is not a directory.' }
    while ($null -ne $item) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Bridge process refuses reparse ancestry.' }
        $item = $item.Parent
    }
}

function Invoke-BridgeProcess {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [AllowEmptyCollection()][AllowEmptyString()][string[]]$ArgumentList = @(),
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [Parameter(Mandatory = $true)][string]$OutputDirectory
    )
    $ErrorActionPreference = 'Stop'
    if (-not [IO.Path]::IsPathRooted($WorkingDirectory)) { throw 'WorkingDirectory must be absolute and canonical.' }
    $canonical = [IO.Path]::GetFullPath($WorkingDirectory)
    if ($canonical -ne $WorkingDirectory -or $canonical -notmatch '^(?:[A-Za-z]:\\|\\\\)') { throw 'WorkingDirectory must be absolute and canonical.' }
    Assert-BridgeDirectory $canonical
    if ([string]::IsNullOrWhiteSpace($OutputDirectory) -or [IO.Path]::IsPathRooted($OutputDirectory)) { throw 'OutputDirectory must be a new relative directory.' }
    $segments = $OutputDirectory -split '[\\/]'
    foreach ($segment in $segments) {
        if ([string]::IsNullOrWhiteSpace($segment) -or $segment -eq '.' -or $segment -eq '..' -or $segment -match '[<>:"|?*]' -or $segment -match '[. ]$') { throw 'Invalid OutputDirectory segment.' }
    }
    $outputPath = $canonical
    for ($index = 0; $index -lt $segments.Count; $index++) {
        $outputPath = Join-Path $outputPath $segments[$index]
        if (Test-Path -LiteralPath $outputPath) {
            Assert-BridgeDirectory $outputPath
            if ($index -eq $segments.Count - 1) { throw 'OutputDirectory already exists.' }
        } else {
            # No -Force: reject a competing creator instead of merging output.
            New-Item -ItemType Directory -Path $outputPath -ErrorAction Stop | Out-Null
            Assert-BridgeDirectory $outputPath
        }
    }
    $stdoutPath = Join-Path $outputPath 'stdout.log'
    $stderrPath = Join-Path $outputPath 'stderr.log'
    $stdout = $null; $stderr = $null; $process = $null; $started = $false
    try {
        $stdout = [IO.File]::Open($stdoutPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
        $stderr = [IO.File]::Open($stderrPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
        $info = New-Object System.Diagnostics.ProcessStartInfo
        $info.FileName = $FilePath
        $info.WorkingDirectory = $canonical
        $info.UseShellExecute = $false
        $info.CreateNoWindow = $true
        $info.RedirectStandardOutput = $true
        $info.RedirectStandardError = $true
        if ($info.PSObject.Properties['ArgumentList']) {
            foreach ($argument in $ArgumentList) { [void]$info.ArgumentList.Add([string]$argument) }
        } else {
            $quoted = foreach ($argument in $ArgumentList) { ConvertTo-BridgeWindowsArgument ([string]$argument) }
            $info.Arguments = $quoted -join ' '
        }
        $process = New-Object System.Diagnostics.Process
        $process.StartInfo = $info
        $startedAt = [DateTimeOffset]::UtcNow.ToString('o')
        $started = $process.Start()
        if (-not $started) { throw 'Bridge child process did not start.' }
        $stdoutCopy = $process.StandardOutput.BaseStream.CopyToAsync($stdout)
        $stderrCopy = $process.StandardError.BaseStream.CopyToAsync($stderr)
        while (-not $process.WaitForExit(100)) {
            if ($stdoutCopy.IsFaulted -or $stderrCopy.IsFaulted -or $stdoutCopy.IsCanceled -or $stderrCopy.IsCanceled) { throw 'Bridge child output transfer failed.' }
        }
        [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($stdoutCopy, $stderrCopy))
        $stdout.Flush(); $stderr.Flush()
        [pscustomobject]@{
            exitCode = $process.ExitCode
            startedAt = $startedAt
            endedAt = [DateTimeOffset]::UtcNow.ToString('o')
            stdoutPath = $stdoutPath
            stderrPath = $stderrPath
        }
    } catch {
        # Avoid exposing ProcessStart exception messages containing command data.
        throw 'Bridge child process or output transfer failed; no successful receipt was produced.'
    } finally {
        try {
            if ($null -ne $process) {
                try {
                    if ($started -and -not $process.HasExited) {
                        if ($null -ne $process.GetType().GetMethod('Kill', [type[]]@([bool]))) { $process.Kill($true) }
                        else { $process.Kill() } # PS5.1: direct child only; upstream owns descendant teardown.
                        $process.WaitForExit()
                    }
                } finally { $process.Dispose() }
            }
        } finally {
            try { if ($null -ne $stdout) { $stdout.Dispose() } }
            finally { if ($null -ne $stderr) { $stderr.Dispose() } }
        }
    }
}


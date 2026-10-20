param(
    [string]$Helper,
    [string]$Node,
    [string]$Child,
    [string]$Root,
    [ValidateSet('write', 'flush', 'dispose', 'cancel', 'cancel-early-receipt')][string]$Mode
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$identityPath = Join-Path $Root 'child.json'
$capturePath = Join-Path $Root 'child-captured.json'
$completedPath = Join-Path $Root 'completed'
$output = 'artifacts/run-001'
. $Helper

if ($Mode -ne 'cancel' -and $Mode -ne 'cancel-early-receipt') {
    # A real FileStream remains underneath the controlled failure. No disk, ACL,
    # sandbox implementation or process-launch behavior is substituted.
    Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
public sealed class BridgeFaultOutputStream : Stream {
    private readonly FileStream inner;
    private readonly string mode, identityPath, capturePath;
    private long written;
    public BridgeFaultOutputStream(string path, string mode, string identityPath, string capturePath) {
        inner = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.Read);
        this.mode = mode; this.identityPath = identityPath; this.capturePath = capturePath;
    }
    private void Capture() {
        if (File.Exists(capturePath)) return;
        int pid = Int32.Parse(File.ReadAllText(identityPath));
        using (Process child = Process.GetProcessById(pid)) {
            File.WriteAllText(capturePath, "{\"pid\":" + pid + ",\"startTicks\":\"" + child.StartTime.ToUniversalTime().Ticks + "\"}", new UTF8Encoding(false));
        }
    }
    public override void Write(byte[] buffer, int offset, int count) {
        Capture();
        if (mode == "write" && written >= 65536) throw new IOException("Controlled output write failure");
        inner.Write(buffer, offset, count); written += count;
    }
    public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken token) {
        try { Write(buffer, offset, count); return Task.FromResult(0); }
        catch (Exception error) { var failed = new TaskCompletionSource<int>(); failed.SetException(error); return failed.Task; }
    }
    public override void Flush() { if (mode == "flush") throw new IOException("Controlled output flush failure"); inner.Flush(); }
    protected override void Dispose(bool disposing) {
        if (disposing) inner.Dispose();
        base.Dispose(disposing);
        if (disposing && mode == "dispose") throw new IOException("Controlled output close failure");
    }
    public override bool CanRead { get { return false; } }
    public override bool CanSeek { get { return false; } }
    public override bool CanWrite { get { return true; } }
    public override long Length { get { return inner.Length; } }
    public override long Position { get { return inner.Position; } set { throw new NotSupportedException(); } }
    public override int Read(byte[] buffer, int offset, int count) { throw new NotSupportedException(); }
    public override long Seek(long offset, SeekOrigin origin) { throw new NotSupportedException(); }
    public override void SetLength(long value) { throw new NotSupportedException(); }
}
'@
    function Open-BridgeOutputStream {
        param([string]$Path)
        if ([IO.Path]::GetFileName($Path) -eq 'stdout.log') {
            return New-Object BridgeFaultOutputStream($Path, $Mode, $identityPath, $capturePath)
        }
        return [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    }
    $receipts = New-Object Collections.Generic.List[object]
    $failure = $null
    try {
        Invoke-BridgeProcess -FilePath $Node -ArgumentList @($Child, 'identity-large', $identityPath, $completedPath) -WorkingDirectory $Root -OutputDirectory $output |
            ForEach-Object { $receipts.Add($_) }
    } catch { $failure = $_.Exception.Message }
    $identity = Get-Content -LiteralPath $capturePath -Raw | ConvertFrom-Json
    $receiptCount = $receipts.Count
} else {
    $runspace = [PowerShell]::Create()
    $inputBuffer = New-Object 'System.Management.Automation.PSDataCollection[psobject]'
    $outputBuffer = New-Object 'System.Management.Automation.PSDataCollection[psobject]'
    $invocation = $null
    $identity = $null
    try {
        [void]$runspace.AddScript({ param($helper, $node, $child, $root, $output, $identityPath, $completedPath, $emitEarlyReceipt)
            . $helper
            # Positive control: output must remain observable even if cancellation
            # later makes EndInvoke throw. This is not a product helper receipt.
            if ($emitEarlyReceipt) { [pscustomobject]@{ fixtureReceipt = 'before-cancel'; exitCode = 0 } }
            Invoke-BridgeProcess -FilePath $node -ArgumentList @($child, 'active', $identityPath, $completedPath) -WorkingDirectory $root -OutputDirectory $output
        }).AddArgument($Helper).AddArgument($Node).AddArgument($Child).AddArgument($Root).AddArgument($output).AddArgument($identityPath).AddArgument($completedPath).AddArgument(($Mode -eq 'cancel-early-receipt'))
        $inputBuffer.Complete()
        # PS5.1 cannot use PS7's generic-method invocation syntax. Reflection selects
        # BeginInvoke<TInput,TOutput>(input, output) on both supported hosts.
        $beginInvoke = $runspace.GetType().GetMethods() | Where-Object {
            $_.Name -eq 'BeginInvoke' -and $_.IsGenericMethodDefinition -and
            $_.GetGenericArguments().Length -eq 2 -and $_.GetParameters().Length -eq 2
        } | Select-Object -First 1
        if ($null -eq $beginInvoke) { throw 'Explicit-output BeginInvoke overload is unavailable.' }
        $typedBeginInvoke = $beginInvoke.MakeGenericMethod([type[]]@([psobject], [psobject]))
        $beginArguments = New-Object object[] 2
        $beginArguments[0] = $inputBuffer.PSObject.BaseObject
        $beginArguments[1] = $outputBuffer.PSObject.BaseObject
        $invocation = $typedBeginInvoke.Invoke($runspace, $beginArguments)
        $deadline = [DateTime]::UtcNow.AddSeconds(10)
        $stdoutPath = Join-Path (Join-Path $Root $output) 'stdout.log'
        $stderrPath = Join-Path (Join-Path $Root $output) 'stderr.log'
        while (-not (Test-Path -LiteralPath $identityPath) -or
            -not (Test-Path -LiteralPath $stdoutPath) -or -not (Test-Path -LiteralPath $stderrPath) -or
            (Get-Item -LiteralPath $stdoutPath).Length -eq 0 -or (Get-Item -LiteralPath $stderrPath).Length -eq 0) {
            if ($invocation.IsCompleted -or [DateTime]::UtcNow -gt $deadline) { throw 'Fixture child did not become ready.' }
            Start-Sleep -Milliseconds 20
        }
        $childId = [int](Get-Content -LiteralPath $identityPath -Raw)
        $ownedChild = [Diagnostics.Process]::GetProcessById($childId)
        try { $identity = @{ pid = $childId; startTicks = [string]$ownedChild.StartTime.ToUniversalTime().Ticks } }
        finally { $ownedChild.Dispose() }
        $runspace.Stop()
        $failure = $null
        try { [void]$runspace.EndInvoke($invocation) }
        catch { $failure = $_.Exception.GetBaseException().GetType().FullName }
        # EndInvoke can throw after objects were already emitted. Its return value
        # cannot establish absence; inspect the independently supplied buffer.
        $receiptCount = $outputBuffer.Count
    } finally {
        try { $runspace.Dispose() }
        finally { $inputBuffer.Dispose(); $outputBuffer.Dispose() }
    }
}

$childExited = $false
try {
    $observed = [Diagnostics.Process]::GetProcessById([int]$identity.pid)
    try {
        # A reused PID is not the owned child. Never terminate by PID/name alone.
        $childExited = $observed.HasExited -or ([string]$observed.StartTime.ToUniversalTime().Ticks -ne [string]$identity.startTicks)
    } finally { $observed.Dispose() }
} catch [ArgumentException] { $childExited = $true }

$released = @()
foreach ($name in @('stdout.log', 'stderr.log')) {
    $path = Join-Path (Join-Path $Root $output) $name
    $exclusive = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    try { $released += $name } finally { $exclusive.Dispose() }
}
[pscustomobject]@{
    mode = $Mode; failure = $failure; receiptCount = $receiptCount
    childPid = $identity.pid; childStartTicks = [string]$identity.startTicks; childExited = $childExited
    releasedLogs = $released; completed = (Test-Path -LiteralPath $completedPath)
    stdoutBytes = (Get-Item -LiteralPath (Join-Path (Join-Path $Root $output) 'stdout.log')).Length
    stderrBytes = (Get-Item -LiteralPath (Join-Path (Join-Path $Root $output) 'stderr.log')).Length
} | ConvertTo-Json -Compress

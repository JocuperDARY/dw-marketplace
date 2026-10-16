<# Runs one suspended child inside a private kill-on-close Job Object. JSON on stdin/stdout only. #>
$ErrorActionPreference = 'Stop'
try {
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    if (-not [IO.Path]::IsPathRooted([string]$request.executable) -or
        $request.timeoutMs -lt 1 -or $request.timeoutMs -gt 600000 -or
        $request.maxOutputBytes -lt 1 -or $request.maxOutputBytes -gt 65536) { throw 'invalid request' }
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class DwBoundedCommand {
    [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES { public int length; public IntPtr descriptor; public int inherit; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct STARTUPINFO {
        public int cb; public string reserved; public string desktop; public string title;
        public int x, y, xSize, ySize, xChars, yChars, fill, flags;
        public short show, reserved2; public IntPtr reservedPtr, input, output, error;
    }
    [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr process, thread; public int pid, tid; }
    [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO startup; public IntPtr attributes; }
    [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMITS {
        public long processTime, jobTime; public uint flags; public UIntPtr minWorkingSet, maxWorkingSet;
        public uint activeLimit; public UIntPtr affinity; public uint priority, scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong readOps, writeOps, otherOps, readBytes, writeBytes, otherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMITS {
        public BASIC_LIMITS basic; public IO_COUNTERS io;
        public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)] struct ACCOUNTING {
        public long user, kernel, periodUser, periodKernel;
        public uint faults, total, active, terminated;
    }
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref EXTENDED_LIMITS info, int length);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out ACCOUNTING info, int length, IntPtr returnedLength);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool member);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr attributes, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr attributes, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returnedSize);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr attributes);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SECURITY_ATTRIBUTES attributes, int size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFile(string name, uint access, uint share, ref SECURITY_ATTRIBUTES security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string application, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string cwd, ref STARTUPINFOEX startup, out PROCESS_INFORMATION information);

    public sealed class Result {
        public string status = "hold", cleanup = "unverified", stdout = "", stderr = "";
        public int? exitCode = null;
        public uint? activeProcesses = null;
        public bool atomicJobBinding = false;
    }
    sealed class Capture { public string text = ""; public bool overflow; }
    static void Require(bool condition) { if (!condition) throw new InvalidOperationException("native command backend failed"); }
    static void Close(ref IntPtr handle) { if (handle != IntPtr.Zero && handle != new IntPtr(-1)) CloseHandle(handle); handle = IntPtr.Zero; }
    static string Quote(string value) {
        StringBuilder output = new StringBuilder("\""); int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { output.Append('\\', slashes * 2 + 1); output.Append(c); slashes = 0; continue; }
            output.Append('\\', slashes); slashes = 0; output.Append(c);
        }
        output.Append('\\', slashes * 2); return output.Append('"').ToString();
    }
    static Task Read(IntPtr handle, int limit, Capture capture) {
        return Task.Run(() => {
            using (FileStream stream = new FileStream(new SafeFileHandle(handle, true), FileAccess.Read, 4096, false)) {
                byte[] buffer = new byte[4096]; using (MemoryStream saved = new MemoryStream()) {
                    int count; while ((count = stream.Read(buffer, 0, buffer.Length)) > 0) {
                        int available = Math.Max(0, limit - (int)saved.Length);
                        if (count > available) capture.overflow = true;
                        saved.Write(buffer, 0, Math.Min(count, available));
                    }
                    capture.text = Encoding.UTF8.GetString(saved.ToArray());
                }
            }
        });
    }
    public static Result Run(string executable, string[] args, int timeout, int limit) {
        Result result = new Result(); IntPtr job = IntPtr.Zero, outRead = IntPtr.Zero, outWrite = IntPtr.Zero;
        IntPtr errRead = IntPtr.Zero, errWrite = IntPtr.Zero, input = IntPtr.Zero;
        IntPtr attributes = IntPtr.Zero, jobList = IntPtr.Zero; bool attributesInitialized = false;
        PROCESS_INFORMATION process = new PROCESS_INFORMATION(); bool assigned = false, created = false;
        Task stdoutTask = null, stderrTask = null; Capture stdout = new Capture(), stderr = new Capture();
        try {
            string application = executable; StringBuilder command = new StringBuilder();
            if (executable.EndsWith(".cmd", StringComparison.OrdinalIgnoreCase) || executable.EndsWith(".bat", StringComparison.OrdinalIgnoreCase)) {
                // cmd expands these characters even inside quoted operands. Refuse rather than reinterpret.
                if (executable.IndexOfAny(new char[] {'%', '!', '^', '"', '\r', '\n'}) >= 0) throw new InvalidOperationException();
                application = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "cmd.exe");
                // Preserve the batch call frame used by npm/CLI shims, including EXIT /B in nested groups.
                command.Append(Quote(application)).Append(" /d /s /c call ").Append(Quote(executable));
                foreach (string arg in args) {
                    if (arg.IndexOfAny(new char[] {'%', '!', '"', '\r', '\n', '&', '|', '<', '>', '^', '(', ')'}) >= 0) throw new InvalidOperationException();
                    command.Append(' ').Append(arg.IndexOfAny(new char[] { ' ', '\t' }) >= 0 || arg.Length == 0 ? Quote(arg) : arg);
                }
            } else {
                command.Append(Quote(executable)); foreach (string arg in args) command.Append(' ').Append(Quote(arg));
            }
            job = CreateJobObject(IntPtr.Zero, null); Require(job != IntPtr.Zero);
            EXTENDED_LIMITS limits = new EXTENDED_LIMITS(); limits.basic.flags = 0x2000;
            Require(SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(EXTENDED_LIMITS))));
            SECURITY_ATTRIBUTES security = new SECURITY_ATTRIBUTES { length = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)), inherit = 1 };
            Require(CreatePipe(out outRead, out outWrite, ref security, 0)); Require(SetHandleInformation(outRead, 1, 0));
            Require(CreatePipe(out errRead, out errWrite, ref security, 0)); Require(SetHandleInformation(errRead, 1, 0));
            input = CreateFile("NUL", 0x80000000, 3, ref security, 3, 0, IntPtr.Zero); Require(input != new IntPtr(-1));
            IntPtr attributeSize = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeSize); Require(attributeSize != IntPtr.Zero);
            attributes = Marshal.AllocHGlobal(attributeSize);
            Require(InitializeProcThreadAttributeList(attributes, 1, 0, ref attributeSize)); attributesInitialized = true;
            jobList = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobList, job);
            Require(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x0002000D), jobList, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
            STARTUPINFOEX startup = new STARTUPINFOEX { startup = new STARTUPINFO { cb = Marshal.SizeOf(typeof(STARTUPINFOEX)), flags = 0x100, input = input, output = outWrite, error = errWrite }, attributes = attributes };
            // Job membership is atomic with creation, including an abrupt backend exit before this method resumes.
            Require(CreateProcess(application, command, IntPtr.Zero, IntPtr.Zero, true, 0x08080004, IntPtr.Zero, null, ref startup, out process));
            created = assigned = true;
            bool member; Require(IsProcessInJob(process.process, job, out member) && member); result.atomicJobBinding = true;
            Close(ref outWrite); Close(ref errWrite); Close(ref input);
            stdoutTask = Read(outRead, limit, stdout); outRead = IntPtr.Zero;
            stderrTask = Read(errRead, limit, stderr); errRead = IntPtr.Zero;
            Require(ResumeThread(process.thread) != UInt32.MaxValue);
            uint wait = WaitForSingleObject(process.process, (uint)timeout);
            Require(wait == 0 || wait == 258);
            if (wait == 258) result.status = "timed_out";
            else { uint code; Require(GetExitCodeProcess(process.process, out code)); result.exitCode = unchecked((int)code); result.status = "completed"; }
        } catch { result.status = "hold"; }
        finally {
            Close(ref outWrite); Close(ref errWrite); Close(ref input);
            bool clean = !created;
            if (assigned) {
                // Normal completion also reclaims descendants that outlive their parent.
                bool terminated = TerminateJobObject(job, 125);
                for (int elapsed = 0; elapsed < 3000; elapsed += 20) {
                    ACCOUNTING accounting;
                    if (!QueryInformationJobObject(job, 1, out accounting, Marshal.SizeOf(typeof(ACCOUNTING)), IntPtr.Zero)) break;
                    result.activeProcesses = accounting.active;
                    if (accounting.active == 0) { clean = true; break; }
                    Thread.Sleep(20);
                }
                if (!terminated && !clean) result.status = "hold";
            } else if (created) {
                // This handle belongs to the child created suspended above; it never ran.
                clean = TerminateProcess(process.process, 125) && WaitForSingleObject(process.process, 3000) == 0;
            }
            Close(ref job); Close(ref process.thread); Close(ref process.process); Close(ref outRead); Close(ref errRead);
            if (attributesInitialized) DeleteProcThreadAttributeList(attributes);
            if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
            if (jobList != IntPtr.Zero) Marshal.FreeHGlobal(jobList);
            try {
                if (stdoutTask != null && stderrTask != null && Task.WaitAll(new Task[] { stdoutTask, stderrTask }, 3000)) {
                    result.stdout = stdout.text; result.stderr = stderr.text;
                    if (stdout.overflow || stderr.overflow) result.status = "output_limit";
                } else if (stdoutTask != null || stderrTask != null) { clean = false; result.status = "hold"; }
            } catch { clean = false; result.status = "hold"; }
            result.cleanup = clean ? "verified_absent" : "unverified";
            if (!clean) result.status = "hold";
        }
        return result;
    }
}
'@
    $result = [DwBoundedCommand]::Run([string]$request.executable, [string[]]@($request.args), [int]$request.timeoutMs, [int]$request.maxOutputBytes)
    $result | ConvertTo-Json -Compress
} catch {
    [Console]::Out.WriteLine('{"status":"hold","cleanup":"unverified","exitCode":null,"stdout":"","stderr":""}')
}

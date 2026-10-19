// Windows 10+ / .NET Framework 4.x. Compiled as winexe: no extra console host.
// A launch owns one private kernel job. There is deliberately no global PID scanner.
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class DwProcessSupervisor
{
    [StructLayout(LayoutKind.Sequential)] struct Security { public int size; public IntPtr descriptor; public int inherit; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct Startup
    {
        public int size; public string reserved, desktop, title;
        public int x, y, width, height, xChars, yChars, fill, flags;
        public short show, reservedSize; public IntPtr reservedPtr, input, output, error;
    }
    [StructLayout(LayoutKind.Sequential)] struct StartupEx { public Startup startup; public IntPtr attributes; }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process, thread; public int pid, tid; }
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits
    {
        public long processTime, jobTime; public uint flags; public UIntPtr minWorkingSet, maxWorkingSet;
        public uint activeLimit; public UIntPtr affinity; public uint priority, scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong reads, writes, others, readBytes, writeBytes, otherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits
    {
        public BasicLimits basic; public IoCounters io; public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)] struct Accounting
    {
        public long user, kernel, periodUser, periodKernel; public uint faults, total, active, terminated;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessBasicInfo
    {
        public IntPtr reserved1, peb, reserved2, reserved3, pid, parentPid;
    }
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr security, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits info, int size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out Accounting info, int size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool member);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcess(string application, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string cwd, ref StartupEx startup, out ProcessInfo info);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref Security security, int size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool all, uint timeout);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int number);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenThread(uint access, bool inherit, uint tid);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CancelSynchronousIo(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool ReadFile(IntPtr file, byte[] buffer, uint size, out uint read, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool WriteFile(IntPtr file, byte[] buffer, uint size, out uint written, IntPtr overlapped);
    [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process, int infoClass, out ProcessBasicInfo info, int size, out int returned);

    static void Require(bool condition) { if (!condition) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    static bool Valid(IntPtr handle) { return handle != IntPtr.Zero && handle != new IntPtr(-1); }
    static void Close(ref IntPtr handle) { if (Valid(handle)) CloseHandle(handle); handle = IntPtr.Zero; }
    static readonly object reasonLock = new object();
    static readonly ManualResetEvent transportStopped = new ManualResetEvent(false);
    static string transportReason;
    static void Signal(string reason)
    {
        lock (reasonLock) { if (transportReason == null || reason == "transport_error") transportReason = reason; }
        transportStopped.Set();
    }
    static string TransportReason() { lock (reasonLock) { return transportReason; } }

    sealed class Options
    {
        public int graceMs = 1500, timeoutMs;
        public bool commandMode;
        public string executable, receipt;
        public string[] arguments;
        public static Options Parse(string[] args)
        {
            Options options = new Options(); int i = 0;
            while (i < args.Length && args[i] != "--")
            {
                string key = args[i++]; if (i == args.Length) throw new ArgumentException();
                string value = args[i++]; int number;
                if (key == "--receipt") { if (!Absolute(value)) throw new ArgumentException(); options.receipt = value; }
                else if (key == "--mode" && (value == "stdio" || value == "command")) options.commandMode = value == "command";
                else if (key == "--grace-ms" && Int32.TryParse(value, out number) && number >= 0 && number <= 30000) options.graceMs = number;
                else if (key == "--timeout-ms" && Int32.TryParse(value, out number) && number >= 0) options.timeoutMs = number;
                else throw new ArgumentException();
            }
            if (i == args.Length || ++i == args.Length) throw new ArgumentException();
            options.executable = args[i++];
            if (!Absolute(options.executable) || !File.Exists(options.executable)) throw new ArgumentException();
            options.arguments = new string[args.Length - i]; Array.Copy(args, i, options.arguments, 0, args.Length - i);
            return options;
        }
    }
    static bool Absolute(string value)
    {
        return !String.IsNullOrEmpty(value) && Path.IsPathRooted(value) &&
            String.Equals(Path.GetFullPath(value), value, StringComparison.OrdinalIgnoreCase);
    }

    // Quote for the Windows argv parser; do not join operands into a shell expression.
    static string Quote(string value)
    {
        StringBuilder output = new StringBuilder("\""); int slashes = 0;
        foreach (char c in value)
        {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { output.Append('\\', slashes * 2 + 1); output.Append(c); slashes = 0; continue; }
            output.Append('\\', slashes); slashes = 0; output.Append(c);
        }
        output.Append('\\', slashes * 2); return output.Append('"').ToString();
    }
    static StringBuilder Command(Options options, out string application)
    {
        application = options.executable; StringBuilder command = new StringBuilder();
        if (application.EndsWith(".cmd", StringComparison.OrdinalIgnoreCase) || application.EndsWith(".bat", StringComparison.OrdinalIgnoreCase))
        {
            // Same narrow shim contract as check-updates: refuse shell expansion rather than change its meaning.
            if (application.IndexOfAny(new char[] { '%', '!', '^', '"', '\r', '\n' }) >= 0) throw new ArgumentException();
            application = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "cmd.exe");
            command.Append(Quote(application)).Append(" /d /s /c call ").Append(Quote(options.executable));
            foreach (string arg in options.arguments)
            {
                if (arg.IndexOfAny(new char[] { '%', '!', '"', '\r', '\n', '&', '|', '<', '>', '^', '(', ')' }) >= 0) throw new ArgumentException();
                command.Append(' ').Append(arg.Length == 0 || arg.IndexOfAny(new char[] { ' ', '\t' }) >= 0 ? Quote(arg) : arg);
            }
        }
        else
        {
            command.Append(Quote(application));
            foreach (string arg in options.arguments)
                command.Append(' ').Append(arg.Length == 0 || arg.IndexOfAny(new char[] { ' ', '\t', '"' }) >= 0 ? Quote(arg) : arg);
        }
        return command;
    }

    // Hold a handle to the original parent, so PID reuse cannot select a new owner.
    static IntPtr ParentHandle()
    {
        ProcessBasicInfo info; int returned;
        Require(NtQueryInformationProcess(GetCurrentProcess(), 0, out info, Marshal.SizeOf(typeof(ProcessBasicInfo)), out returned) == 0);
        IntPtr parent = OpenProcess(0x00101000, false, checked((int)info.parentPid.ToInt64()));
        Require(Valid(parent));
        try
        {
            long parentCreated, selfCreated, unused1, unused2, unused3;
            Require(GetProcessTimes(parent, out parentCreated, out unused1, out unused2, out unused3));
            Require(GetProcessTimes(GetCurrentProcess(), out selfCreated, out unused1, out unused2, out unused3));
            Require(parentCreated <= selfCreated && WaitForSingleObject(parent, 0) == 258);
            return parent;
        }
        catch { Close(ref parent); throw; }
    }

    // Each relay has one fixed 16 KiB buffer. Blocked peers apply backpressure, not unbounded buffering.
    // Background threads and CancelSynchronousIo keep shutdown bounded even when a peer stops reading.
    sealed class Relay
    {
        readonly IntPtr source, destination; readonly bool input, stopOnEof;
        readonly Thread thread; readonly object threadLock = new object();
        IntPtr nativeThread; volatile bool cancelled;
        public volatile bool failed;
        public Relay(IntPtr source, IntPtr destination, bool input, bool stopOnEof = true)
        {
            this.source = source; this.destination = destination; this.input = input;
            this.stopOnEof = stopOnEof;
            thread = new Thread(Run); thread.IsBackground = true;
        }
        public void Start() { thread.Start(); }
        public bool Join(int milliseconds) { return thread.Join(milliseconds); }
        public void Cancel()
        {
            cancelled = true;
            lock (threadLock) { if (Valid(nativeThread)) CancelSynchronousIo(nativeThread); }
        }
        void Run()
        {
            bool eof = false;
            try
            {
                lock (threadLock) { nativeThread = OpenThread(0x0001, false, GetCurrentThreadId()); Require(Valid(nativeThread)); }
                byte[] buffer = new byte[16384];
                while (!cancelled)
                {
                    uint count;
                    if (!ReadFile(source, buffer, (uint)buffer.Length, out count, IntPtr.Zero))
                    {
                        int code = Marshal.GetLastWin32Error();
                        if (code == 109 || code == 232 || code == 233) { eof = true; break; }
                        throw new Win32Exception(code);
                    }
                    if (count == 0) { eof = true; break; }
                    if (cancelled) break;
                    // .NET Framework FileStream can silently swallow ERROR_BROKEN_PIPE on writes.
                    // Read the native result so transport loss cannot masquerade as successful delivery.
                    uint written;
                    Require(WriteFile(destination, buffer, count, out written, IntPtr.Zero));
                    Require(written == count);
                }
            }
            catch { if (!cancelled) { failed = true; Signal("transport_error"); } }
            finally
            {
                IntPtr owned = input ? destination : source; Close(ref owned);
                lock (threadLock) { Close(ref nativeThread); }
                if (input && eof && stopOnEof) Signal("stdin_closed");
            }
        }
    }

    static uint Active(IntPtr job)
    {
        Accounting accounting;
        Require(QueryInformationJobObject(job, 1, out accounting, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
        return accounting.active;
    }
    sealed class Result
    {
        public string reason = "start_failed", cleanup = "not_started";
        public int? childPid, childExitCode, nativeError;
        public uint? activeProcesses;
        public bool forced, atomicJobBinding, outputComplete;
        public string Json(long elapsed)
        {
            return "{\"schemaVersion\":1,\"supervisorPid\":" + Process.GetCurrentProcess().Id +
                ",\"childPid\":" + Number(childPid) + ",\"reason\":\"" + reason + "\",\"cleanup\":\"" + cleanup +
                "\",\"activeProcesses\":" + (activeProcesses.HasValue ? activeProcesses.Value.ToString() : "null") +
                ",\"forced\":" + Bool(forced) + ",\"atomicJobBinding\":" + Bool(atomicJobBinding) +
                ",\"childExitCode\":" + Number(childExitCode) + ",\"nativeError\":" + Number(nativeError) +
                ",\"outputComplete\":" + Bool(outputComplete) + ",\"elapsedMs\":" + elapsed +
                ",\"workingSetBytes\":" + Process.GetCurrentProcess().WorkingSet64 + "}";
        }
        static string Number(int? value) { return value.HasValue ? value.Value.ToString() : "null"; }
        static string Bool(bool value) { return value ? "true" : "false"; }
    }

    static int Main(string[] args)
    {
        Stopwatch clock = Stopwatch.StartNew(); Result result = new Result(); int exitCode = 125;
        IntPtr job = IntPtr.Zero, parent = IntPtr.Zero, inRead = IntPtr.Zero, inWrite = IntPtr.Zero;
        IntPtr outRead = IntPtr.Zero, outWrite = IntPtr.Zero, errRead = IntPtr.Zero, errWrite = IntPtr.Zero;
        IntPtr attributes = IntPtr.Zero, jobList = IntPtr.Zero, handleList = IntPtr.Zero;
        bool attributesInitialized = false, created = false;
        ProcessInfo child = new ProcessInfo(); Relay input = null, output = null, error = null;
        FileStream receipt = null;
        try
        {
            Options options = Options.Parse(args); string application;
            StringBuilder command = Command(options, out application);
            if (options.receipt != null) receipt = new FileStream(options.receipt, FileMode.CreateNew, FileAccess.Write, FileShare.Read);
            parent = ParentHandle();
            Require(Valid(GetStdHandle(-10)) && Valid(GetStdHandle(-11)) && Valid(GetStdHandle(-12)));
            job = CreateJobObject(IntPtr.Zero, null); Require(Valid(job));
            ExtendedLimits limits = new ExtendedLimits(); limits.basic.flags = 0x2000; // KILL_ON_JOB_CLOSE; no breakaway.
            Require(SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(ExtendedLimits))));
            Security security = new Security { size = Marshal.SizeOf(typeof(Security)), inherit = 1 };
            Require(CreatePipe(out inRead, out inWrite, ref security, 0)); Require(SetHandleInformation(inWrite, 1, 0));
            Require(CreatePipe(out outRead, out outWrite, ref security, 0)); Require(SetHandleInformation(outRead, 1, 0));
            Require(CreatePipe(out errRead, out errWrite, ref security, 0)); Require(SetHandleInformation(errRead, 1, 0));
            IntPtr size = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size); Require(size != IntPtr.Zero);
            attributes = Marshal.AllocHGlobal(size);
            Require(InitializeProcThreadAttributeList(attributes, 2, 0, ref size)); attributesInitialized = true;
            jobList = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobList, job);
            Require(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x0002000D), jobList, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
            handleList = Marshal.AllocHGlobal(IntPtr.Size * 3);
            Marshal.WriteIntPtr(handleList, 0, inRead); Marshal.WriteIntPtr(handleList, IntPtr.Size, outWrite); Marshal.WriteIntPtr(handleList, IntPtr.Size * 2, errWrite);
            Require(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x00020002), handleList, new IntPtr(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero));
            StartupEx startup = new StartupEx { startup = new Startup { size = Marshal.SizeOf(typeof(StartupEx)), flags = 0x100, input = inRead, output = outWrite, error = errWrite }, attributes = attributes };
            // Atomic job binding closes the spawn/assign crash window. CREATE_NO_WINDOW prevents console fan-out.
            Require(CreateProcess(application, command, IntPtr.Zero, IntPtr.Zero, true, 0x08080004, IntPtr.Zero, null, ref startup, out child));
            created = true; result.childPid = child.pid; result.cleanup = "unverified";
            bool member; Require(IsProcessInJob(child.process, job, out member) && member); result.atomicJobBinding = true;
            Close(ref inRead); Close(ref outWrite); Close(ref errWrite);
            input = new Relay(GetStdHandle(-10), inWrite, true, !options.commandMode); input.Start(); inWrite = IntPtr.Zero;
            output = new Relay(outRead, GetStdHandle(-11), false); output.Start(); outRead = IntPtr.Zero;
            error = new Relay(errRead, GetStdHandle(-12), false); error.Start(); errRead = IntPtr.Zero;
            Require(ResumeThread(child.thread) != UInt32.MaxValue);
            // Idle sessions sleep in the kernel; there is no periodic whole-machine or per-PID scan.
            IntPtr[] waits = new IntPtr[] { child.process, parent, transportStopped.SafeWaitHandle.DangerousGetHandle() };
            uint wait = WaitForMultipleObjects(3, waits, false, options.timeoutMs == 0 ? UInt32.MaxValue : (uint)options.timeoutMs);
            Require(wait <= 2 || wait == 258);
            string reason = TransportReason();
            result.reason = reason == "transport_error" ? reason : wait == 0 ? "child_exit" :
                wait == 1 ? "parent_exit" : wait == 258 ? "timeout_elapsed" : reason;
            input.Cancel();
            long graceDeadline = clock.ElapsedMilliseconds + options.graceMs;
            while (Active(job) != 0 && clock.ElapsedMilliseconds < graceDeadline) { input.Cancel(); Thread.Sleep(20); }
            if (Active(job) != 0) { result.forced = true; Require(TerminateJobObject(job, 125)); }
            exitCode = result.reason == "timeout_elapsed" ? 124 : result.reason == "transport_error" ? 74 : 0;
        }
        catch (Exception exception)
        {
            Win32Exception native = exception as Win32Exception;
            if (native != null) result.nativeError = native.NativeErrorCode;
            result.reason = created ? "supervisor_error" : "start_failed";
            exitCode = exception is ArgumentException ? 64 : 125;
        }
        finally
        {
            if (input != null) input.Cancel();
            Close(ref inRead); Close(ref inWrite); Close(ref outWrite); Close(ref errWrite);
            if (created)
            {
                try
                {
                    if (Active(job) != 0) { result.forced = true; Require(TerminateJobObject(job, 125)); }
                    long deadline = clock.ElapsedMilliseconds + 3000;
                    bool rootExited;
                    do
                    {
                        result.activeProcesses = Active(job);
                        uint rootWait = WaitForSingleObject(child.process, 0);
                        Require(rootWait == 0 || rootWait == 258);
                        rootExited = rootWait == 0;
                        if (result.activeProcesses == 0 && rootExited) break;
                        Thread.Sleep(20);
                    }
                    while (clock.ElapsedMilliseconds < deadline);
                    result.cleanup = result.activeProcesses == 0 && rootExited ? "verified_absent" : "unverified";
                    if (rootExited)
                    {
                        uint code; Require(GetExitCodeProcess(child.process, out code)); result.childExitCode = unchecked((int)code);
                    }
                    if ((result.reason == "child_exit" || (result.reason == "stdin_closed" && !result.forced)) && result.childExitCode.HasValue)
                        exitCode = result.childExitCode.Value;
                }
                catch (Exception exception)
                {
                    result.cleanup = "unverified"; result.reason = "supervisor_error";
                    Win32Exception native = exception as Win32Exception;
                    if (native != null) result.nativeError = native.NativeErrorCode;
                }
                if (result.cleanup != "verified_absent") exitCode = 125;
            }
            // Last-handle close is the independent kernel fallback, including hard supervisor termination.
            Close(ref job); Close(ref parent); Close(ref child.thread); Close(ref child.process);
            Close(ref outRead); Close(ref errRead);
            if (attributesInitialized) DeleteProcThreadAttributeList(attributes);
            if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
            if (jobList != IntPtr.Zero) Marshal.FreeHGlobal(jobList);
            if (handleList != IntPtr.Zero) Marshal.FreeHGlobal(handleList);
            bool outputDone = output == null || output.Join(1000);
            bool errorDone = error == null || error.Join(1000);
            result.outputComplete = outputDone && errorDone && (output == null || !output.failed) && (error == null || !error.failed);
            if (output != null && !outputDone) output.Cancel();
            if (error != null && !errorDone) error.Cancel();
            if (!result.outputComplete && exitCode == 0) exitCode = 74;
            string json = result.Json(clock.ElapsedMilliseconds);
            if (receipt != null)
            {
                try { byte[] bytes = Encoding.UTF8.GetBytes(json + "\n"); receipt.Write(bytes, 0, bytes.Length); receipt.Flush(true); }
                catch { exitCode = 125; }
                finally { receipt.Dispose(); }
            }
            // A blocked stderr consumer must not keep this supervisor alive after cleanup.
            Thread diagnostic = new Thread(() => { try { Console.Error.WriteLine("DW_PROCESS_SUPERVISOR " + json); } catch { } });
            diagnostic.IsBackground = true; diagnostic.Start(); diagnostic.Join(100);
        }
        return exitCode;
    }
}

// Managed mode is a private, bounded control channel. Only retained handles select a target.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;

internal static partial class DwProcessSupervisor
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder name, ref int length);

    sealed class ManagedOptions
    {
        public string session, binding;
        public int timeoutMs, maxOutputBytes, retentionMs = 30000;
        public Options child = new Options();
        public static ManagedOptions Parse(string[] args)
        {
            ManagedOptions options = new ManagedOptions(); HashSet<string> seen = new HashSet<string>(); int i = 0;
            while (i < args.Length && args[i] != "--")
            {
                string key = args[i++]; if (i == args.Length || !seen.Add(key)) throw new ArgumentException();
                string value = args[i++]; int number;
                if (key == "--mode" && value == "managed") { }
                else if (key == "--session" && Regex.IsMatch(value, "\\A[0-9a-f]{32}\\z")) options.session = value;
                else if (key == "--binding" && Regex.IsMatch(value, "\\A[0-9a-f]{64}\\z")) options.binding = value;
                else if (key == "--timeout-ms" && Int32.TryParse(value, out number) && number > 0) options.timeoutMs = number;
                else if (key == "--max-output-bytes" && Int32.TryParse(value, out number) && number > 0 && number <= 67108864) options.maxOutputBytes = number;
                else if (key == "--retention-ms" && Int32.TryParse(value, out number) && number >= 1000 && number <= 300000) options.retentionMs = number;
                else if (key == "--grace-ms" && Int32.TryParse(value, out number) && number >= 0 && number <= 30000) options.child.graceMs = number;
                else throw new ArgumentException();
            }
            if (!seen.Contains("--mode") || options.session == null || options.binding == null || options.timeoutMs == 0 || options.maxOutputBytes == 0 ||
                i == args.Length || ++i == args.Length) throw new ArgumentException();
            options.child.executable = args[i++];
            if (!Absolute(options.child.executable)) throw new ArgumentException();
            options.child.arguments = new string[args.Length - i]; Array.Copy(args, i, options.child.arguments, 0, args.Length - i);
            return options;
        }
    }

    // Each worker owns its native thread cancellation handle. A pipe peer cannot extend teardown.
    abstract class ManagedWorker
    {
        readonly object gate = new object(); IntPtr nativeThread; protected volatile bool cancelled;
        readonly Thread thread;
        protected ManagedWorker() { thread = new Thread(Entry); thread.IsBackground = true; }
        void Entry()
        {
            try { lock (gate) { nativeThread = OpenThread(0x0001, false, GetCurrentThreadId()); Require(Valid(nativeThread)); } Run(); }
            catch { OnFailure(); }
            finally { lock (gate) { Close(ref nativeThread); } }
        }
        protected abstract void Run();
        protected abstract void OnFailure();
        public void Start() { thread.Start(); }
        public bool Join(int ms) { return thread.Join(ms); }
        public void Cancel() { cancelled = true; lock (gate) { if (Valid(nativeThread)) CancelSynchronousIo(nativeThread); } Wake(); }
        protected virtual void Wake() { }
    }

    sealed class ManagedWriter : ManagedWorker
    {
        readonly ManagedRun owner; readonly Queue<byte[]> queue = new Queue<byte[]>(); readonly object gate = new object();
        readonly AutoResetEvent ready = new AutoResetEvent(false); int queuedBytes; bool finished;
        public ManagedWriter(ManagedRun owner) { this.owner = owner; }
        public bool Put(Dictionary<string, object> record)
        {
            byte[] bytes = Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(record) + "\n");
            lock (gate)
            {
                if (cancelled || finished || queuedBytes + bytes.Length > 1048576 || queue.Count >= 128) return false;
                queue.Enqueue(bytes); queuedBytes += bytes.Length;
            }
            ready.Set(); return true;
        }
        public void Finish() { lock (gate) { finished = true; } ready.Set(); }
        protected override void Wake() { ready.Set(); }
        protected override void OnFailure() { if (!cancelled) owner.Stop("transport_error"); }
        protected override void Run()
        {
            while (!cancelled)
            {
                byte[] bytes = null;
                lock (gate) { if (queue.Count > 0) { bytes = queue.Dequeue(); queuedBytes -= bytes.Length; } else if (finished) return; }
                if (bytes == null) { ready.WaitOne(); continue; }
                int offset = 0;
                while (offset < bytes.Length && !cancelled)
                {
                    byte[] part = bytes;
                    if (offset != 0) { part = new byte[bytes.Length - offset]; Buffer.BlockCopy(bytes, offset, part, 0, part.Length); }
                    uint count; Require(WriteFile(GetStdHandle(-11), part, (uint)part.Length, out count, IntPtr.Zero));
                    if (count == 0) throw new IOException(); offset += (int)count;
                }
            }
        }
    }

    sealed class ManagedOutput : ManagedWorker
    {
        readonly ManagedRun owner; IntPtr source; readonly string stream;
        public volatile bool complete;
        public ManagedOutput(ManagedRun owner, IntPtr source, string stream) { this.owner = owner; this.source = source; this.stream = stream; }
        protected override void OnFailure() { if (!cancelled) owner.Stop("transport_error"); }
        protected override void Run()
        {
            try
            {
                byte[] buffer = new byte[16384];
                while (!cancelled)
                {
                    uint count;
                    if (!ReadFile(source, buffer, (uint)buffer.Length, out count, IntPtr.Zero))
                    {
                        int code = Marshal.GetLastWin32Error(); if (code == 109 || code == 232 || code == 233) { complete = true; return; }
                        throw new Win32Exception(code);
                    }
                    if (count == 0) { complete = true; return; }
                    if (cancelled || !owner.Output(stream, buffer, (int)count)) return;
                }
            }
            finally { Close(ref source); }
        }
    }

    sealed class ManagedReader : ManagedWorker
    {
        readonly ManagedRun owner;
        public ManagedReader(ManagedRun owner) { this.owner = owner; }
        protected override void OnFailure() { if (!cancelled) owner.Stop("protocol_error"); }
        protected override void Run()
        {
            byte[] one = new byte[1], line = new byte[8192]; int length = 0;
            while (!cancelled)
            {
                uint count;
                if (!ReadFile(GetStdHandle(-10), one, 1, out count, IntPtr.Zero))
                {
                    int code = Marshal.GetLastWin32Error();
                    if (code == 109 || code == 232 || code == 233) { owner.Stop(length == 0 ? "control_eof" : "protocol_error"); return; }
                    throw new Win32Exception(code);
                }
                if (count == 0) { owner.Stop(length == 0 ? "control_eof" : "protocol_error"); return; }
                if (one[0] == 10)
                {
                    if (length > 0 && line[length - 1] == 13) length--;
                    if (!owner.Command(new UTF8Encoding(false, true).GetString(line, 0, length))) { owner.Stop("protocol_error"); return; }
                    length = 0;
                }
                else { if (length == line.Length) { owner.Stop("protocol_error"); return; } line[length++] = one[0]; }
            }
        }
    }

    sealed class ManagedRun
    {
        readonly ManagedOptions options;
        readonly object gate = new object(), outputGate = new object();
        readonly Queue<Dictionary<string, string>> commands = new Queue<Dictionary<string, string>>();
        readonly ManualResetEvent watchdogDone = new ManualResetEvent(false);
        readonly Stopwatch elapsed = new Stopwatch();
        ManagedWriter writer; ManagedReader reader; ManagedOutput output, error; Thread watchdog;
        IntPtr job, parent, inRead, inWrite, outRead, outWrite, errRead, errWrite, attributes, jobList, handleList;
        ProcessInfo child;
        bool initialized, created, terminal, rootExited, gracefulRequested, forced, outputFailed, abort;
        string stopReason, cleanup = "unknown", token = Guid.NewGuid().ToString("N");
        long lastCommand, sequence, outputBytes, graceDeadline = Int64.MaxValue;
        uint? activeProcesses; int? childExitCode;
        Dictionary<string, object> identity;
        public ManagedRun(ManagedOptions options) { this.options = options; }
        Dictionary<string, object> Record(string type)
        {
            return new Dictionary<string, object> { { "v", 1 }, { "type", type }, { "session", options.session }, { "binding", options.binding } };
        }
        void Emit(Dictionary<string, object> record) { if (!writer.Put(record)) Stop("transport_backpressure"); }
        public void Stop(string reason)
        {
            lock (gate)
            {
                if (stopReason == null) stopReason = reason;
                if (reason == "output_limit") outputFailed = true;
                if (reason == "parent_exit" || reason == "control_eof" || reason == "protocol_error" ||
                    reason == "transport_error" || reason == "transport_backpressure") abort = true;
            }
        }
        string Reason() { lock (gate) { return stopReason; } }
        public bool Output(string stream, byte[] bytes, int count)
        {
            lock (outputGate)
            {
                if (terminal) return false;
                int accepted = (int)Math.Min(count, options.maxOutputBytes - outputBytes);
                if (accepted > 0)
                {
                    Dictionary<string, object> record = Record("output"); record["stream"] = stream; record["seq"] = ++sequence;
                    record["data"] = Convert.ToBase64String(bytes, 0, accepted); outputBytes += accepted; Emit(record);
                }
                if (accepted < count) { Stop("output_limit"); return false; }
                return Reason() == null;
            }
        }
        // Commands deliberately accept only this flat scalar grammar: escaped identifiers, duplicate
        // keys, unknown fields, nonintegral IDs and nested data have no interpretation or side effects.
        public bool Command(string text)
        {
            if (!Regex.IsMatch(text, "\\A\\s*\\{(?:\\s*\"[A-Za-z]+\"\\s*:\\s*(?:\"[A-Za-z0-9_]+\"|[0-9]+)\\s*,)*\\s*\"[A-Za-z]+\"\\s*:\\s*(?:\"[A-Za-z0-9_]+\"|[0-9]+)\\s*\\}\\s*\\z")) return false;
            Dictionary<string, string> command = new Dictionary<string, string>();
            foreach (Match match in Regex.Matches(text, "\"([A-Za-z]+)\"\\s*:\\s*(\"[A-Za-z0-9_]+\"|[0-9]+)"))
            { if (command.ContainsKey(match.Groups[1].Value)) return false; command.Add(match.Groups[1].Value, match.Groups[2].Value); }
            string version, session, binding, idText, op, handle; long id;
            if (command.Count != 6 || !command.TryGetValue("v", out version) || version != "1" ||
                !command.TryGetValue("session", out session) || session != "\"" + options.session + "\"" ||
                !command.TryGetValue("binding", out binding) || binding != "\"" + options.binding + "\"" ||
                !command.TryGetValue("processHandleToken", out handle) || handle != "\"" + token + "\"" ||
                !command.TryGetValue("id", out idText) || !Int64.TryParse(idText, out id) || id < 1 || id > 9007199254740991L ||
                !command.TryGetValue("op", out op) || !Regex.IsMatch(op, "\\A\"(observe|graceful|terminate|inputEof|release)\"\\z")) return false;
            lock (gate)
            {
                if (id <= lastCommand || commands.Count >= 64) return false;
                lastCommand = id; commands.Enqueue(command); return true;
            }
        }
        Dictionary<string, object> State()
        {
            return new Dictionary<string, object> { { "rootExited", rootExited }, { "activeProcesses", activeProcesses },
                { "childExitCode", childExitCode }, { "cleanup", cleanup }, { "gracefulRequested", gracefulRequested }, { "forced", forced } };
        }
        void Observe()
        {
            activeProcesses = Active(job); uint wait = WaitForSingleObject(child.process, 0); Require(wait == 0 || wait == 258); rootExited = wait == 0;
            if (rootExited) { uint code; Require(GetExitCodeProcess(child.process, out code)); childExitCode = unchecked((int)code); }
            cleanup = rootExited && activeProcesses == 0 ? "verified_absent" : "running";
        }
        void Kill()
        {
            if (Active(job) != 0) { lock (gate) { forced = true; } Require(TerminateJobObject(job, 125)); }
        }
        void Cleanup()
        {
            Close(ref inWrite); Kill(); long deadline = Stopwatch.GetTimestamp() + Stopwatch.Frequency * 3;
            do { Observe(); if (cleanup == "verified_absent") return; Thread.Sleep(10); } while (Stopwatch.GetTimestamp() < deadline);
            cleanup = "unknown";
        }
        void EndSession()
        {
            if (terminal) return;
            Cleanup();
            bool stdoutDone = output == null || output.Join(500), stderrDone = error == null || error.Join(500);
            if (!stdoutDone) output.Cancel(); if (!stderrDone) error.Cancel();
            bool complete;
            lock (outputGate)
            {
                lock (gate) { complete = stdoutDone && stderrDone && output != null && output.complete && error != null && error.complete && !outputFailed; }
                Dictionary<string, object> record = Record("terminal"); record["identity"] = identity; record["reason"] = Reason() ?? "child_exit";
                record["cleanup"] = cleanup; record["rootExited"] = rootExited; record["activeProcesses"] = activeProcesses;
                record["childExitCode"] = childExitCode; record["forced"] = forced; record["outputComplete"] = complete;
                record["outputBytes"] = outputBytes; record["atomicJobBinding"] = true; Emit(record); terminal = true;
            }
        }
        void StartWatchdog()
        {
            watchdog = new Thread(() =>
            {
                try
                {
                    long remaining = options.timeoutMs - elapsed.ElapsedMilliseconds;
                    uint wait = WaitForMultipleObjects(2, new IntPtr[] { parent, watchdogDone.SafeWaitHandle.DangerousGetHandle() }, false, (uint)Math.Max(0, remaining));
                    if (wait == 1) return;
                    Stop(wait == 0 ? "parent_exit" : wait == 258 ? "timeout_elapsed" : "supervisor_error");
                    // This path never waits for the control reader, event writer or lifetime loop.
                    Kill();
                }
                catch { Stop("supervisor_error"); }
            });
            watchdog.IsBackground = true; watchdog.Start();
        }
        void Launch()
        {
            string application; StringBuilder command = DwProcessSupervisor.Command(options.child, out application);
            parent = ParentHandle(); Require(Valid(GetStdHandle(-10)) && Valid(GetStdHandle(-11)));
            job = CreateJobObject(IntPtr.Zero, null); Require(Valid(job));
            ExtendedLimits limits = new ExtendedLimits(); limits.basic.flags = 0x2000;
            Require(SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(ExtendedLimits))));
            Security security = new Security { size = Marshal.SizeOf(typeof(Security)), inherit = 1 };
            Require(CreatePipe(out inRead, out inWrite, ref security, 0)); Require(SetHandleInformation(inWrite, 1, 0));
            Require(CreatePipe(out outRead, out outWrite, ref security, 0)); Require(SetHandleInformation(outRead, 1, 0));
            Require(CreatePipe(out errRead, out errWrite, ref security, 0)); Require(SetHandleInformation(errRead, 1, 0));
            IntPtr size = IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size); Require(size != IntPtr.Zero);
            attributes = Marshal.AllocHGlobal(size); Require(InitializeProcThreadAttributeList(attributes, 2, 0, ref size)); initialized = true;
            jobList = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobList, job);
            Require(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x0002000D), jobList, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
            handleList = Marshal.AllocHGlobal(IntPtr.Size * 3);
            Marshal.WriteIntPtr(handleList, 0, inRead); Marshal.WriteIntPtr(handleList, IntPtr.Size, outWrite); Marshal.WriteIntPtr(handleList, IntPtr.Size * 2, errWrite);
            Require(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x00020002), handleList, new IntPtr(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero));
            StartupEx startup = new StartupEx { startup = new Startup { size = Marshal.SizeOf(typeof(StartupEx)), flags = 0x100, input = inRead, output = outWrite, error = errWrite }, attributes = attributes };
            Require(CreateProcess(application, command, IntPtr.Zero, IntPtr.Zero, true, 0x08080004, IntPtr.Zero, null, ref startup, out child));
            created = true; elapsed.Start();
            StartWatchdog();
            bool member; Require(IsProcessInJob(child.process, job, out member) && member);
            long createdAt, parentCreated, unused1, unused2, unused3;
            Require(GetProcessTimes(child.process, out createdAt, out unused1, out unused2, out unused3));
            Require(GetProcessTimes(parent, out parentCreated, out unused1, out unused2, out unused3));
            ProcessBasicInfo parentInfo; int returned;
            Require(NtQueryInformationProcess(GetCurrentProcess(), 0, out parentInfo, Marshal.SizeOf(typeof(ProcessBasicInfo)), out returned) == 0);
            StringBuilder image = new StringBuilder(32768); int imageLength = image.Capacity;
            Require(QueryFullProcessImageName(child.process, 0, image, ref imageLength));
            identity = new Dictionary<string, object> { { "pid", child.pid }, { "creationTimeFiletime", createdAt.ToString() },
                { "processHandleToken", token }, { "parentPid", checked((int)parentInfo.parentPid.ToInt64()) },
                { "parentCreationTimeFiletime", parentCreated.ToString() }, { "executablePath", image.ToString() } };
            Close(ref inRead); Close(ref outWrite); Close(ref errWrite);
            Dictionary<string, object> started = Record("started"); started["identity"] = identity; started["atomicJobBinding"] = true; Emit(started);
            output = new ManagedOutput(this, outRead, "stdout"); outRead = IntPtr.Zero; output.Start();
            error = new ManagedOutput(this, errRead, "stderr"); errRead = IntPtr.Zero; error.Start();
            reader = new ManagedReader(this); reader.Start();
            Require(ResumeThread(child.thread) != UInt32.MaxValue); Close(ref child.thread);
        }
        public int Run()
        {
            int exitCode = 0;
            writer = new ManagedWriter(this); writer.Start();
            try
            {
                Launch(); long retentionDeadline = Int64.MaxValue;
                while (true)
                {
                    // The deadline watchdog is one-shot. Keep the original parent
                    // observable while retaining an already completed command.
                    uint parentWait = WaitForSingleObject(parent, 0);
                    Require(parentWait == 0 || parentWait == 258);
                    if (parentWait == 0) Stop("parent_exit");
                    Observe();
                    if (!terminal)
                    {
                        if (rootExited) Stop("child_exit");
                        if (elapsed.ElapsedMilliseconds >= graceDeadline) Stop("graceful");
                        if (Reason() != null) { EndSession(); retentionDeadline = elapsed.ElapsedMilliseconds + options.retentionMs; }
                    }
                    lock (gate) { if (terminal && abort) break; }
                    Dictionary<string, string> command = null;
                    lock (gate) { if (commands.Count > 0) command = commands.Dequeue(); }
                    if (command != null)
                    {
                        string op = command["op"].Trim('"');
                        if (op == "inputEof" || op == "graceful") Close(ref inWrite);
                        if (op == "graceful" && !terminal) { gracefulRequested = true; graceDeadline = elapsed.ElapsedMilliseconds + options.child.graceMs; }
                        if ((op == "terminate" || op == "release") && !terminal)
                        { Stop(op == "terminate" ? "terminated" : "released"); EndSession(); retentionDeadline = elapsed.ElapsedMilliseconds + options.retentionMs; }
                        Observe(); Dictionary<string, object> response = Record("response"); response["id"] = Int64.Parse(command["id"]); response["op"] = op;
                        response["identity"] = identity; response["state"] = State(); Emit(response);
                        if (op == "release") break;
                    }
                    if (terminal && elapsed.ElapsedMilliseconds >= retentionDeadline) break;
                    Thread.Sleep(10);
                }
            }
            catch (Exception exception)
            {
                exitCode = exception is ArgumentException ? 64 : 125;
                if (identity != null)
                {
                    Stop("supervisor_error");
                    try { EndSession(); }
                    catch { cleanup = "unknown"; }
                }
                else
                {
                string state = "never_created";
                if (created) { try { Cleanup(); state = cleanup == "verified_absent" ? "created_reclaimed" : "unknown"; } catch { cleanup = "unknown"; state = "unknown"; } }
                Dictionary<string, object> failed = Record("launchFailed"); failed["reason"] = created ? "supervisor_error" : "start_failed";
                failed["nativeError"] = exception is Win32Exception ? (object)((Win32Exception)exception).NativeErrorCode : null;
                failed["startState"] = state; failed["cleanup"] = created ? cleanup : "verified_absent"; Emit(failed);
                }
            }
            finally
            {
                watchdogDone.Set(); if (watchdog != null) watchdog.Join(1000);
                if (reader != null) { reader.Cancel(); reader.Join(200); }
                if (created) { try { Cleanup(); } catch { exitCode = 125; } }
                if (output != null) { output.Cancel(); output.Join(200); } if (error != null) { error.Cancel(); error.Join(200); }
                Close(ref job); Close(ref parent); Close(ref child.thread); Close(ref child.process);
                Close(ref inRead); Close(ref inWrite); Close(ref outRead); Close(ref outWrite); Close(ref errRead); Close(ref errWrite);
                if (initialized) DeleteProcThreadAttributeList(attributes);
                if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
                if (jobList != IntPtr.Zero) Marshal.FreeHGlobal(jobList); if (handleList != IntPtr.Zero) Marshal.FreeHGlobal(handleList);
                writer.Finish(); if (!writer.Join(500)) { writer.Cancel(); writer.Join(200); }
            }
            return exitCode;
        }
    }
    static int ManagedMain(string[] args)
    {
        try { return new ManagedRun(ManagedOptions.Parse(args)).Run(); }
        catch (ArgumentException) { return 64; }
        catch { return 125; }
    }
}

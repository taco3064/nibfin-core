using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Text;
using System.Runtime.CompilerServices;
using Microsoft.Win32.SafeHandles;

// Owner-operated configuration reader only. It never launches an Agent role.
// Assign the suspended child before it can create helpers. No breakaway flag.
public static class NibfinMcpJob
{
    public static int Main(string[] args)
    {
        try
        {
            Check(args.Length == 2);
            ReadConfiguration(args[0], args[1]);
            Console.Error.WriteLine("NIBFIN_WINDOWS_MCP_TERMINATED");
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("NIBFIN_WINDOWS_MCP_JOB_FAILED");
            if (error.Message.StartsWith("WINDOWS_MCP_JOB_UNVERIFIED_LINE_"))
                Console.Error.WriteLine(error.Message);
            return 1;
        }
    }
    [StructLayout(LayoutKind.Sequential)]
    struct Security { public int Length; public IntPtr Descriptor; public int Inherit; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct Startup
    {
        public int Size; public IntPtr Reserved, Desktop, Title;
        public int X, Y, XSize, YSize, XCount, YCount, Fill, Flags;
        public short Show, ReservedSize; public IntPtr ReservedBytes;
        public IntPtr Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct StartupEx { public Startup Info; public IntPtr Attributes; }
    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInfo { public IntPtr Process, Thread; public int Id, ThreadId; }
    [StructLayout(LayoutKind.Sequential)]
    struct Limits
    {
        public long ProcessTime, JobTime; public uint Flags;
        public UIntPtr MinWorking, MaxWorking; public uint Active;
        public UIntPtr Affinity; public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct Extended
    {
        public Limits Basic;
        public ulong Reads, Writes, Other, ReadBytes, WriteBytes, OtherBytes;
        public UIntPtr ProcessMemory, JobMemory, PeakProcess, PeakJob;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct Accounting
    {
        public long User, Kernel, PeriodUser, PeriodKernel;
        public uint Faults, Processes, Active, Terminated;
    }
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int kind,
        ref Extended value, int size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool QueryInformationJobObject(IntPtr job, int kind,
        out Accounting value, int size, IntPtr length);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetProcessTimes(IntPtr process, out long created,
        out long exited, out long kernel, out long user);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CreatePipe(out IntPtr read, out IntPtr write,
        ref Security security, int size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool InitializeProcThreadAttributeList(IntPtr list, int count,
        int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags,
        IntPtr key, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")]
    static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcess(string executable, StringBuilder command,
        IntPtr processAttributes, IntPtr threadAttributes, bool inherit,
        uint flags, IntPtr environment, string cwd, ref StartupEx startup,
        out ProcessInfo info);

    static void Check(bool value, [CallerLineNumber] int line = 0)
    {
        if (!value) throw new IOException("WINDOWS_MCP_JOB_UNVERIFIED_LINE_" +
            line + "_WIN32_" + Marshal.GetLastWin32Error());
    }
    static void Close(ref IntPtr handle)
    {
        if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; }
    }
    static FileStream Stream(ref IntPtr handle, FileAccess access)
    {
        var owned = new SafeFileHandle(handle, true);
        handle = IntPtr.Zero;
        return new FileStream(owned, access);
    }
    static void Drain(Stream source, Stream destination)
    {
        byte[] buffer = new byte[8192];
        int count, total = 0;
        while ((count = source.Read(buffer, 0, buffer.Length)) > 0)
        {
            total += count;
            if (total > 2 * 1024 * 1024) throw new IOException("MCP_OUTPUT_LIMIT");
            if (destination != null)
            { destination.Write(buffer, 0, count); destination.Flush(); }
        }
    }
    public static void ReadConfiguration(string executable, string cwd)
    {
        IntPtr job = IntPtr.Zero, input = IntPtr.Zero, childInput = IntPtr.Zero;
        IntPtr output = IntPtr.Zero, childOutput = IntPtr.Zero;
        IntPtr error = IntPtr.Zero, childError = IntPtr.Zero;
        IntPtr attributes = IntPtr.Zero, handles = IntPtr.Zero;
        ProcessInfo process = new ProcessInfo();
        bool assigned = false, attributesInitialized = false;
        try
        {
            job = CreateJobObject(IntPtr.Zero, null);
            Check(job != IntPtr.Zero);
            var limits = new Extended();
            limits.Basic.Flags = 0x2000; // KILL_ON_JOB_CLOSE; no breakaway.
            Check(SetInformationJobObject(job, 9, ref limits,
                Marshal.SizeOf(typeof(Extended))));
            var security = new Security();
            security.Length = Marshal.SizeOf(typeof(Security));
            security.Inherit = 1;
            Check(CreatePipe(out childInput, out input, ref security, 0));
            Check(CreatePipe(out output, out childOutput, ref security, 0));
            Check(CreatePipe(out error, out childError, ref security, 0));
            foreach (var handle in new[] { input, output, error })
                Check(SetHandleInformation(handle, 1, 0));
            IntPtr attributeSize = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeSize);
            Check(attributeSize != IntPtr.Zero);
            attributes = Marshal.AllocHGlobal(attributeSize);
            Check(InitializeProcThreadAttributeList(attributes, 1, 0,
                ref attributeSize));
            attributesInitialized = true;
            handles = Marshal.AllocHGlobal(IntPtr.Size * 3);
            Marshal.WriteIntPtr(handles, 0, childInput);
            Marshal.WriteIntPtr(handles, IntPtr.Size, childOutput);
            Marshal.WriteIntPtr(handles, IntPtr.Size * 2, childError);
            Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20002),
                handles, new IntPtr(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero));
            var startup = new StartupEx();
            startup.Info.Size = Marshal.SizeOf(typeof(StartupEx));
            startup.Info.Flags = 0x100;
            startup.Info.Input = childInput; startup.Info.Output = childOutput;
            startup.Info.Error = childError; startup.Attributes = attributes;
            Check(!executable.Contains("\"") && !executable.Contains("\0"));
            Check(CreateProcess(executable, new StringBuilder("\"" + executable +
                "\" app-server --stdio"), IntPtr.Zero, IntPtr.Zero, true,
                0x08080004, IntPtr.Zero, cwd, ref startup, out process));
            long created, exited, kernel, user;
            Check(GetProcessTimes(process.Process, out created, out exited,
                out kernel, out user));
            Console.Error.WriteLine("NIBFIN_WINDOWS_MCP_PROCESS " +
                process.Id + " " + created);
            Check(AssignProcessToJobObject(job, process.Process));
            assigned = true;
            Check(ResumeThread(process.Thread) != UInt32.MaxValue);
            Close(ref childInput); Close(ref childOutput); Close(ref childError);
            if (attributes != IntPtr.Zero)
            {
                if (attributesInitialized) DeleteProcThreadAttributeList(attributes);
                Marshal.FreeHGlobal(attributes);
            }
            if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
            using (var stdin = Stream(ref input, FileAccess.Write))
            using (var stdout = Stream(ref output, FileAccess.Read))
            using (var stderr = Stream(ref error, FileAccess.Read))
            {
                var copyIn = Task.Run(() =>
                { Drain(Console.OpenStandardInput(), stdin); stdin.Close(); });
                var copyOut = Task.Run(() => Drain(stdout, Console.OpenStandardOutput()));
                var copyError = Task.Run(() => Drain(stderr, null));
                // A faulted output pump must not strand a child with an open job.
                while (!copyIn.IsCompleted)
                {
                    Check(!copyOut.IsFaulted && !copyError.IsFaulted);
                    Thread.Sleep(10);
                }
                copyIn.GetAwaiter().GetResult();
                Check(TerminateJobObject(job, 0));
                bool absent = false;
                for (int i = 0; i < 100; i++)
                {
                    Accounting state;
                    Check(QueryInformationJobObject(job, 1, out state,
                        Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
                    if (state.Active == 0) { absent = true; break; }
                    Thread.Sleep(10);
                }
                Check(absent && Task.WaitAll(new[] { copyOut, copyError }, 1000));
            }
        }
        finally
        {
            // An unassigned child has never been resumed and cannot have helpers.
            if (process.Process != IntPtr.Zero && !assigned)
                TerminateProcess(process.Process, 1);
            if (job != IntPtr.Zero) TerminateJobObject(job, 1);
            Close(ref job); Close(ref process.Thread); Close(ref process.Process);
            Close(ref input); Close(ref output); Close(ref error);
            Close(ref childInput); Close(ref childOutput); Close(ref childError);
        }
    }
}

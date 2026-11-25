# ConPTY ブリッジ(Windows PowerShell 5.1 用。ネイティブモジュール不要)
#
# 起動: powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File bridge.ps1
#   stdin : フレーム [type:1][len:uint32 LE][payload]
#             2 = 起動(最初に 1 回)。UTF-8 の「key=value」を NUL で区切ったもの
#                 file=絶対パス / arg=引数(複数可) / cwd=作業フォルダ / cols=桁 / rows=行
#                 env=NAME=VALUE(複数可。1 つも無ければブリッジの環境を継ぐ)
#             0 = 端末への入力(生バイト)
#             1 = リサイズ(cols:uint16 LE, rows:uint16 LE)
#   stdout: PTY 出力の生バイト
#   stderr: ブリッジ自身の失敗だけを「[pty-bridge] 理由」(UTF-8)で書く
#   終了コード: 子の終了コード。ブリッジ自身の失敗は 1(stderr の有無で区別する)
#   stdin が閉じたら(親の終了を含む)子プロセスツリーを終了して自分も終わる
#
# このファイルは BOM なしで置き、一時ファイルへ書き出すときに BOM を付ける(BOM が無いと 5.1 は ANSI として読む)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$source = @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

public static class PtyBridge
{
    const byte FrameInput = 0, FrameResize = 1, FrameStart = 2;
    const int MaxFrame = 64 * 1024 * 1024;
    const int GraceMs = 1000;   // CTRL_CLOSE を送ってから強制終了するまで
    const int DrainMs = 5000;   // 子の終了後、出力の終わりを待つ間隔

    static IntPtr hPty, hJob, hProcess;
    static int ptyClosed;
    static volatile bool writing, parentGone;
    static readonly object ptyLock = new object();
    static Stream stdin;
    static FileStream ptyIn, ptyOut;

    public static int Run()
    {
        stdin = Console.OpenStandardInput();
        byte type;
        byte[] payload = ReadFrame(out type);
        if (payload == null) return 0;  // 起動指示の前に親が終わった
        if (type != FrameStart) throw new InvalidDataException("the first frame must be a start frame");
        Start(payload);

        Thread output = new Thread(PumpOutput);
        output.IsBackground = true;
        output.Start();
        Thread input = new Thread(PumpInput);
        input.IsBackground = true;
        input.Start();

        WaitForSingleObject(hProcess, 0xFFFFFFFF);
        uint code;
        GetExitCodeProcess(hProcess, out code);

        // 旧い Windows の ClosePseudoConsole は出力を流し切るまで戻らないので、読み取りと並行して呼ぶ
        ClosePtyAsync();
        // 親の読み取り待ちなら流し切るまで待つ(端末が閉じないだけなら見切る)
        while (!output.Join(DrainMs) && writing && !parentGone) { }
        // 自分で終了した子が残したプロセス(既定ブラウザーなど)は道連れにしない
        SetKillOnClose(false);
        return unchecked((int)code);
    }

    // stdin が開いたままの Environment.Exit は約 2 秒止まるので使わない
    public static void Exit(int code)
    {
        TerminateProcess(GetCurrentProcess(), unchecked((uint)code));
    }

    static void Start(byte[] payload)
    {
        string file = null, cwd = null;
        short cols = 80, rows = 24;
        List<string> args = new List<string>();
        List<string> env = new List<string>();
        foreach (string record in new UTF8Encoding(false).GetString(payload).Split('\0'))
        {
            int eq = record.IndexOf('=');
            if (eq < 0) continue;
            string value = record.Substring(eq + 1);
            switch (record.Substring(0, eq))
            {
                case "file": file = value; break;
                case "arg": args.Add(value); break;
                case "cwd": cwd = value; break;
                case "cols": cols = ToSize(int.Parse(value)); break;
                case "rows": rows = ToSize(int.Parse(value)); break;
                case "env": env.Add(value); break;
            }
        }
        if (string.IsNullOrEmpty(file) || !Path.IsPathRooted(file))
            throw new ArgumentException("file must be an absolute path: " + file);

        string application = file;
        string commandLine;
        string ext = Path.GetExtension(file).ToLowerInvariant();
        if (ext == ".cmd" || ext == ".bat")
        {
            application = Path.Combine(Environment.SystemDirectory, "cmd.exe");
            commandLine = BatchCommandLine(file, args);
        }
        else
        {
            StringBuilder sb = new StringBuilder("\"" + file + "\"");
            foreach (string arg in args) { sb.Append(' '); AppendArg(sb, arg); }
            commandLine = sb.ToString();
        }

        // 親が死んだら子孫ごと消える Job。明示的な離脱(CREATE_BREAKAWAY_FROM_JOB)は許す
        hJob = CreateJobObjectW(IntPtr.Zero, null);
        if (hJob == IntPtr.Zero) throw Error("CreateJobObject");
        if (!SetKillOnClose(true)) throw Error("SetInformationJobObject");

        IntPtr inRead, inWrite, outRead, outWrite;
        if (!CreatePipe(out inRead, out inWrite, IntPtr.Zero, 65536)) throw Error("CreatePipe");
        if (!CreatePipe(out outRead, out outWrite, IntPtr.Zero, 1024 * 1024)) throw Error("CreatePipe");
        int hr = CreatePseudoConsole(new Coord(cols, rows), inRead, outWrite, 0, out hPty);
        if (hr != 0) throw new Win32Exception(hr, "CreatePseudoConsole: 0x" + hr.ToString("X8"));
        CloseHandle(inRead);
        CloseHandle(outWrite);
        ptyIn = new FileStream(new SafeFileHandle(inWrite, true), FileAccess.Write, 1, false);
        ptyOut = new FileStream(new SafeFileHandle(outRead, true), FileAccess.Read, 1, false);

        IntPtr size = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
        IntPtr list = Marshal.AllocHGlobal(size);
        if (!InitializeProcThreadAttributeList(list, 2, 0, ref size)) throw Error("InitializeProcThreadAttributeList");
        IntPtr jobs = Marshal.AllocHGlobal(IntPtr.Size);
        Marshal.WriteIntPtr(jobs, hJob);
        if (!UpdateProcThreadAttribute(list, 0, (IntPtr)0x20016, hPty, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero))
            throw Error("PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE");
        if (!UpdateProcThreadAttribute(list, 0, (IntPtr)0x2000D, jobs, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero))
            throw Error("PROC_THREAD_ATTRIBUTE_JOB_LIST");

        StartupInfoEx si = new StartupInfoEx();
        si.cb = Marshal.SizeOf(typeof(StartupInfoEx));
        // 標準ハンドルを空で明示しないと、子がブリッジのパイプを使って PTY を素通りする
        si.dwFlags = 0x100;  // STARTF_USESTDHANDLES
        si.lpAttributeList = list;

        // Ctrl+C の無効化は子へ継がれるため、戻しておく
        SetConsoleCtrlHandler(IntPtr.Zero, false);

        const uint flags = 0x80000 | 0x400;  // EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT
        ProcessInformation pi;
        bool ok = CreateProcessW(application, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, false, flags,
            EnvironmentBlock(env), string.IsNullOrEmpty(cwd) ? null : cwd, ref si, out pi);
        if (!ok) throw Error("CreateProcess " + application);
        CloseHandle(pi.hThread);
        hProcess = pi.hProcess;
        DeleteProcThreadAttributeList(list);
    }

    static void PumpOutput()
    {
        Stream stdout = Console.OpenStandardOutput();
        byte[] buffer = new byte[65536];
        bool broken = false;
        try
        {
            int n;
            while ((n = ptyOut.Read(buffer, 0, buffer.Length)) > 0)
            {
                if (broken) continue;  // 親がいなくても読み続け、conhost を詰まらせない
                writing = true;
                try { stdout.Write(buffer, 0, n); stdout.Flush(); }
                catch (IOException) { broken = true; }
                writing = false;
            }
        }
        catch (IOException) { }
        catch (ObjectDisposedException) { }
    }

    static void PumpInput()
    {
        try
        {
            byte type;
            byte[] data;
            while ((data = ReadFrame(out type)) != null)
            {
                if (type == FrameInput)
                {
                    try { ptyIn.Write(data, 0, data.Length); ptyIn.Flush(); }
                    catch (IOException) { }  // 子の終了と行き違いになった入力
                }
                else if (type == FrameResize && data.Length >= 4)
                {
                    Coord c = new Coord(ToSize(data[0] | data[1] << 8), ToSize(data[2] | data[3] << 8));
                    lock (ptyLock) { if (ptyClosed == 0) ResizePseudoConsole(hPty, c); }
                }
            }
        }
        catch (Exception) { }  // 壊れたフレームは切断と同じに扱う

        // 親が終わった。端末を閉じて(CTRL_CLOSE)猶予を与え、残ったら Job ごと終了する
        parentGone = true;
        ClosePtyAsync();
        WaitForSingleObject(hProcess, GraceMs);
        TerminateJobObject(hJob, 1);
        Thread.Sleep(GraceMs);
        Exit(1);  // 通常は Run 側が先に終わる
    }

    static void ClosePtyAsync()
    {
        lock (ptyLock)
        {
            if (ptyClosed != 0) return;
            ptyClosed = 1;
        }
        Thread t = new Thread(delegate() { ClosePseudoConsole(hPty); });
        t.IsBackground = true;
        t.Start();
    }

    // 1 フレーム読む。ストリームの終わりなら null
    static byte[] ReadFrame(out byte type)
    {
        type = 0;
        byte[] head = new byte[5];
        if (!ReadFully(head)) return null;
        type = head[0];
        uint length = BitConverter.ToUInt32(head, 1);
        if (length > MaxFrame) throw new InvalidDataException("frame too large: " + length);
        byte[] data = new byte[length];
        return ReadFully(data) ? data : null;
    }

    static bool ReadFully(byte[] buffer)
    {
        int offset = 0;
        while (offset < buffer.Length)
        {
            int n = stdin.Read(buffer, offset, buffer.Length - offset);
            if (n <= 0) return false;
            offset += n;
        }
        return true;
    }

    static short ToSize(int value)
    {
        return (short)Math.Max(1, Math.Min(value, short.MaxValue));
    }

    // CommandLineToArgvW の規則で引用する
    static void AppendArg(StringBuilder sb, string arg)
    {
        if (arg.Length > 0 && arg.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '"' }) < 0)
        {
            sb.Append(arg);
            return;
        }
        sb.Append('"');
        int slashes = 0;
        foreach (char c in arg)
        {
            if (c == '\\') { slashes++; continue; }
            sb.Append('\\', c == '"' ? slashes * 2 + 1 : slashes);
            slashes = 0;
            sb.Append(c);
        }
        sb.Append('\\', slashes * 2).Append('"');
    }

    // cmd.exe 経由の起動。全引数を引用し、" は ""、% は展開されない形に置き換える
    static string BatchCommandLine(string file, List<string> args)
    {
        StringBuilder sb = new StringBuilder("cmd.exe /d /e:ON /v:OFF /s /c \"");
        AppendBatchArg(sb, file);
        foreach (string arg in args) { sb.Append(' '); AppendBatchArg(sb, arg); }
        return sb.Append('"').ToString();
    }

    static void AppendBatchArg(StringBuilder sb, string arg)
    {
        if (arg.IndexOfAny(new char[] { '\r', '\n' }) >= 0)
            throw new ArgumentException("batch file arguments cannot contain line breaks");
        sb.Append('"');
        int slashes = 0;
        foreach (char c in arg)
        {
            if (c == '\\') { slashes++; sb.Append(c); continue; }
            if (c == '"') sb.Append('\\', slashes).Append('"');
            else if (c == '%') sb.Append("%%cd:~,");
            slashes = 0;
            sb.Append(c);
        }
        sb.Append('\\', slashes).Append('"');
    }

    static byte[] EnvironmentBlock(List<string> env)
    {
        if (env.Count == 0) return null;
        env.Sort(StringComparer.OrdinalIgnoreCase);
        return Encoding.Unicode.GetBytes(string.Join("\0", env.ToArray()) + "\0\0");
    }

    static bool SetKillOnClose(bool on)
    {
        JobLimits limits = new JobLimits();
        limits.LimitFlags = 0x800u | (on ? 0x2000u : 0u);  // BREAKAWAY_OK | KILL_ON_JOB_CLOSE
        return SetInformationJobObject(hJob, 9, ref limits, Marshal.SizeOf(typeof(JobLimits)));
    }

    static Exception Error(string what)
    {
        int code = Marshal.GetLastWin32Error();
        return new Win32Exception(code, what + ": " + new Win32Exception(code).Message + " (" + code + ")");
    }

    [StructLayout(LayoutKind.Sequential)]
    struct Coord
    {
        public short X, Y;
        public Coord(short x, short y) { X = x; Y = y; }
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct StartupInfoEx
    {
        public int cb;
        public string lpReserved, lpDesktop, lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError, lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInformation
    {
        public IntPtr hProcess, hThread;
        public int dwProcessId, dwThreadId;
    }

    // JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    [StructLayout(LayoutKind.Sequential)]
    struct JobLimits
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
        public ulong Io0, Io1, Io2, Io3, Io4, Io5;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll")]
    static extern int CreatePseudoConsole(Coord size, IntPtr hInput, IntPtr hOutput, uint flags, out IntPtr phPC);
    [DllImport("kernel32.dll")]
    static extern int ResizePseudoConsole(IntPtr hPC, Coord size);
    [DllImport("kernel32.dll")]
    static extern void ClosePseudoConsole(IntPtr hPC);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CreatePipe(out IntPtr read, out IntPtr write, IntPtr attributes, int size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returnSize);
    [DllImport("kernel32.dll")]
    static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, byte[] environment, string directory, ref StartupInfoEx startupInfo, out ProcessInformation processInformation);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JobLimits info, int length);
    [DllImport("kernel32.dll")]
    static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll")]
    static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);
    [DllImport("kernel32.dll")]
    static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll")]
    static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")]
    static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")]
    static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);
}
'@

try {
    Add-Type -TypeDefinition $source
    [PtyBridge]::Exit([PtyBridge]::Run())
} catch {
    $e = $_.Exception
    while ($e.InnerException) { $e = $e.InnerException }
    $bytes = [Text.Encoding]::UTF8.GetBytes('[pty-bridge] ' + $e.Message + "`n")
    $stderr = [Console]::OpenStandardError()
    $stderr.Write($bytes, 0, $bytes.Length)
    $stderr.Flush()
    if ('PtyBridge' -as [type]) { [PtyBridge]::Exit(1) }
    [Environment]::Exit(1)
}

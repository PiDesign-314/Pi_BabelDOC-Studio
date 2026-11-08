// BabelDOC Studio 启动器：双击后调用同目录 runtime\pythonw.exe -s app.py。
// 单独做成 exe 是为了能参与代码签名：Windows 11 智能应用控制会拦 Start.bat 这类脚本，
// 但会放行带可信签名的可执行文件。Start.bat 仍然保留，作为旧环境的后备入口。
//
// 首次运行时，启动器还会尽力清掉本目录内所有文件的「来自 Internet」标记
// （Zone.Identifier，等价于右键 → 属性 → 解除锁定），这样用户不用再手动执行
// Unblock-File；清理在后台线程里做，不影响启动速度。失败（无权限、非 NTFS）就跳过。
//
// 注意：如果 Windows 直接拦住了 BabelDOC Studio.exe 本身（未签名应用拦截），
// 启动器根本没有机会运行，这一步就帮不上忙——那种情况只能关 SAC 或换签名版。
//
// 用 .NET Framework 自带的 csc.exe 编译（见 tools/build_portable.py），不打包额外运行时。
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

[assembly: AssemblyTitle("BabelDOC Studio")]
[assembly: AssemblyDescription("BabelDOC Studio 启动器")]
[assembly: AssemblyProduct("BabelDOC Studio")]
[assembly: AssemblyCompany("PiDesign-314")]
[assembly: AssemblyCopyright("https://github.com/PiDesign-314/Pi_BabelDOC-Studio")]
[assembly: AssemblyVersion("1.0.1.0")]
[assembly: AssemblyFileVersion("1.0.1.0")]

internal static class NativeMethods
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool DeleteFile(string fileName);
}

internal static class Launcher
{
    private const string ReadyMarker = ".babeldoc-unblocked";

    private static void RemoveZoneIdentifier(string file)
    {
        // Windows 会忽略不存在的数据流；这里不需要先判断文件是否存在标记。
        if (file.Length >= 240) { return; }
        try { NativeMethods.DeleteFile(file + ":Zone.Identifier"); }
        catch { }
    }

    private static void UnblockPackage(string root)
    {
        try
        {
            if (File.Exists(Path.Combine(root, ReadyMarker))) { return; }
            foreach (string file in Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories))
            {
                RemoveZoneIdentifier(file);
            }
            try { File.WriteAllText(Path.Combine(root, ReadyMarker), "unblocked\r\n"); }
            catch { }
        }
        catch { }
    }

    private static string FindMissingFile(string root)
    {
        string pythonw = Path.Combine(root, "runtime", "pythonw.exe");
        string app = Path.Combine(root, "app.py");
        if (!File.Exists(pythonw)) { return pythonw; }
        if (!File.Exists(app)) { return app; }
        return null;
    }

    [STAThread]
    private static int Main(string[] args)
    {
        string root = AppDomain.CurrentDomain.BaseDirectory;
        string missing = FindMissingFile(root);
        if (missing != null)
        {
            MessageBox.Show(
                "没有找到 " + missing + "。\n\n"
                + "请把整个 ZIP 完整解压到一个有写入权限的目录，再双击本程序；不要只复制单个文件。\n"
                + "也可以直接双击同目录下的 Start.bat。",
                "BabelDOC Studio",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return 1;
        }

        // 先处理马上会被执行的几个文件，再在后台清理其余文件。
        RemoveZoneIdentifier(Path.Combine(root, "runtime", "pythonw.exe"));
        RemoveZoneIdentifier(Path.Combine(root, "app.py"));
        RemoveZoneIdentifier(Path.Combine(root, "Start.bat"));
        Thread unblocker = new Thread(delegate() { UnblockPackage(root); });
        unblocker.IsBackground = true;
        unblocker.Start();

        try
        {
            ProcessStartInfo startInfo = new ProcessStartInfo(Path.Combine(root, "runtime", "pythonw.exe"));
            startInfo.Arguments = "-s \"" + Path.Combine(root, "app.py") + "\"";
            startInfo.WorkingDirectory = root;
            startInfo.UseShellExecute = false;
            Process.Start(startInfo);
        }
        catch (Exception error)
        {
            MessageBox.Show(
                "启动失败：" + error.Message + "\n\n可以尝试直接双击同目录下的 Start.bat。",
                "BabelDOC Studio",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return 1;
        }

        // 给清理线程一点时间；应用已经启动，启动器晚几秒退出没有影响。
        unblocker.Join(TimeSpan.FromSeconds(60));
        return 0;
    }
}

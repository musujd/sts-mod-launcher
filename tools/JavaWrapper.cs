using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Windows.Forms;

namespace STSModLauncher
{
    internal static class JavaWrapper
    {
        private static readonly string DefaultLauncher = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "STSModLauncher",
            "尖塔Mod启动器.exe");

        private static void Log(string directory, string message)
        {
            try
            {
                File.AppendAllText(
                    Path.Combine(directory, "sts-java-wrapper.log"),
                    DateTime.Now.ToString("o") + " " + message + Environment.NewLine,
                    Encoding.UTF8);
            }
            catch
            {
                // 日志失败不影响启动
            }
        }

        private static string Quote(string value)
        {
            if (value == null) return "\"\"";
            return "\"" + value.Replace("\"", "\\\"") + "\"";
        }

        private static string BuildArguments(string[] args)
        {
            StringBuilder builder = new StringBuilder();
            for (int index = 0; index < args.Length; index += 1)
            {
                if (index > 0) builder.Append(' ');
                builder.Append(Quote(args[index]));
            }
            return builder.ToString();
        }

        [STAThread]
        private static void Main(string[] args)
        {
            string directory = AppDomain.CurrentDomain.BaseDirectory;
            string realJava = Path.Combine(directory, "javaw-real.exe");
            string joined = string.Join(" ", args);

            bool isChild = Environment.GetEnvironmentVariable("STS_LAUNCHER_CHILD") == "1";
            // 只接管 Steam 的「启动 with mod」入口；原版 `-jar desktop-1.0.jar` 直接转发。
            bool isModLaunch =
                joined.IndexOf("mts-launcher.jar", StringComparison.OrdinalIgnoreCase) >= 0;

            Log(directory, "args=" + joined + " | child=" + isChild + " | mod=" + isModLaunch);

            if (!isChild && isModLaunch)
            {
                string pathFile = Path.Combine(directory, "sts-launcher.path");
                string launcher = File.Exists(pathFile)
                    ? File.ReadAllText(pathFile, Encoding.UTF8).Trim()
                    : DefaultLauncher;
                if (!File.Exists(launcher)) launcher = DefaultLauncher;

                if (!File.Exists(launcher))
                {
                    // 启动器被卸载/移动时不要让 with mod 启动失败，直接回退到原版 MTS。
                    Log(directory, "launcher not found; forwarding to original javaw");
                }
                else
                {
                    launcher = Path.GetFullPath(launcher.Trim());
                    try
                    {
                        Log(directory, "opening launcher: " + launcher);
                        Process.Start(new ProcessStartInfo
                        {
                            FileName = launcher,
                            WorkingDirectory = Path.GetDirectoryName(launcher),
                            UseShellExecute = true
                        });
                        Log(directory, "launcher start requested");
                        return;
                    }
                    catch (Exception error)
                    {
                        Log(directory, "launcher start failed; forwarding to original javaw: " + error);
                    }
                }
            }

            if (!File.Exists(realJava))
            {
                Log(directory, "javaw-real.exe not found");
                MessageBox.Show(
                    "Java 启动入口损坏：找不到 javaw-real.exe。\n请用 Steam 校验游戏文件后重新安装接管。",
                    "尖塔 Mod 启动器",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
                return;
            }

            ProcessStartInfo info = new ProcessStartInfo
            {
                FileName = realJava,
                Arguments = BuildArguments(args),
                // 保持调用者的工作目录（启动器传进来的是游戏根目录），MTS 需要在这里找游戏文件。
                WorkingDirectory = Environment.CurrentDirectory,
                UseShellExecute = false
            };

            try
            {
                Log(directory, "forwarding to " + realJava + " | cwd=" + Environment.CurrentDirectory);
                using (Process process = Process.Start(info))
                {
                    if (process != null)
                    {
                        Log(directory, "child pid=" + process.Id);
                        process.WaitForExit();
                        Log(directory, "child exited=" + process.ExitCode);
                        Environment.ExitCode = process.ExitCode;
                    }
                }
            }
            catch (Exception error)
            {
                Log(directory, "forward failed: " + error);
                MessageBox.Show(
                    "启动 ModTheSpire 失败：\n" + error.Message,
                    "尖塔 Mod 启动器",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
            }
        }
    }
}

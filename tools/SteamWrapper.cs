using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Windows.Forms;

namespace STSModLauncher
{
    internal static class SteamWrapper
    {
        private static readonly string DefaultLauncher = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "STSModLauncher",
            "尖塔Mod启动器.exe");

        private static string ReadLauncherPath(string baseDir)
        {
            string pathFile = Path.Combine(baseDir, "sts-launcher.path");
            if (!File.Exists(pathFile)) return null;

            try
            {
                return File.ReadAllText(pathFile, Encoding.UTF8).Trim();
            }
            catch
            {
                return null;
            }
        }

        [STAThread]
        private static void Main()
        {
            string baseDir = AppDomain.CurrentDomain.BaseDirectory;
            string launcher = ReadLauncherPath(baseDir);

            if (string.IsNullOrEmpty(launcher) || !File.Exists(launcher))
            {
                launcher = File.Exists(DefaultLauncher) ? DefaultLauncher : null;
            }

            if (string.IsNullOrEmpty(launcher))
            {
                MessageBox.Show(
                    "没有找到尖塔 Mod 启动器。\n\n" +
                    "请重新运行启动器的「安装 Steam 接管」，或检查：\n" +
                    DefaultLauncher,
                    "尖塔 Mod 启动器",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Warning);
                return;
            }

            try
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = launcher,
                    WorkingDirectory = Path.GetDirectoryName(launcher),
                    UseShellExecute = true
                });
            }
            catch (Exception error)
            {
                MessageBox.Show(
                    "启动尖塔 Mod 启动器失败：\n" + error.Message,
                    "尖塔 Mod 启动器",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
            }
        }
    }
}

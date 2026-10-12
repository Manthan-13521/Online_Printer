using System;
using System.Diagnostics;
using System.Collections.Generic;
using System.Web.Script.Serialization;
using System.Drawing;
using System.IO;
using System.Text.RegularExpressions;
using System.Windows.Forms;

namespace PrintGo.ControlCenter
{
    public class ControlCenterForm : Form
    {
        private NotifyIcon trayIcon;
        private ContextMenuStrip trayMenu;
        private Timer refreshTimer;

        // UI Controls
        private Label lblShopTitle;
        private Label lblAgentVersion;
        private Label lblStatusBadge;
        private Label lblServer;

        // Diagnostics & Dependencies Card
        private Label lblSumatraStatus;
        private Label lblDpapiStatus;

        // Production Printer Card
        private Label lblPrinterName;
        private Label lblPrinterStatus;
        private Button btnCheckPrinter;

        // Activity Card
        private Label lblLastHeartbeat;
        private Label lblLastPrint;

        // Action Buttons
        private Button btnStartAgent;
        private Button btnStopAgent;
        private Button btnRestartAgent;
        private Button btnOpenAdmin;
        private Button btnPair;
        private Button btnCopyDiag;
        private Button btnOpenLogs;
        private Button btnSupportPackage;

        private string currentServerUrl = null;
        private string appDataDir;
        private string statusFilePath;
        private string agentExePath;
        private string sumatraExePath;

        [STAThread]
        public static void Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            bool startMinimized = false;
            string pairUrl = null;

            foreach (var arg in args)
            {
                if (arg.Equals("--minimized", StringComparison.OrdinalIgnoreCase) ||
                    arg.Equals("-m", StringComparison.OrdinalIgnoreCase))
                {
                    startMinimized = true;
                }
                else if (arg.StartsWith("printgo://", StringComparison.OrdinalIgnoreCase))
                {
                    pairUrl = arg;
                }
            }

            var form = new ControlCenterForm(startMinimized, pairUrl);
            Application.Run(form);
        }

        public ControlCenterForm(bool startMinimized, string pairUrl)
        {
            appDataDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "PrintGo"
            );
            statusFilePath = Path.Combine(appDataDir, "agent-status.json");
            agentExePath = FindAgentExecutable();
            sumatraExePath = FindSumatraExecutable();

            InitializeComponent();
            SetupTray();

            if (!string.IsNullOrEmpty(pairUrl))
            {
                HandlePairUrl(pairUrl);
            }

            EnsureSingleAgentRunning();
            RefreshStatus();

            refreshTimer = new Timer();
            refreshTimer.Interval = 2500;
            refreshTimer.Tick += (s, e) => RefreshStatus();
            refreshTimer.Start();

            if (startMinimized)
            {
                WindowState = FormWindowState.Minimized;
                ShowInTaskbar = false;
                Hide();
            }
        }

        private string FindAgentExecutable()
        {
            string baseDir = AppDomain.CurrentDomain.BaseDirectory;
            string direct = Path.Combine(baseDir, "PrintGo-Agent.exe");
            if (File.Exists(direct)) return direct;
            string appDataExe = Path.Combine(appDataDir, "PrintGo-Agent.exe");
            if (File.Exists(appDataExe)) return appDataExe;
            return direct;
        }

        private string FindSumatraExecutable()
        {
            string baseDir = AppDomain.CurrentDomain.BaseDirectory;
            string direct = Path.Combine(baseDir, "SumatraPDF.exe");
            if (File.Exists(direct)) return direct;
            string vendor = Path.Combine(baseDir, "vendor", "SumatraPDF.exe");
            if (File.Exists(vendor)) return vendor;
            string appData = Path.Combine(appDataDir, "SumatraPDF.exe");
            if (File.Exists(appData)) return appData;

            string pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            string pfSumatra = Path.Combine(pf, "SumatraPDF", "SumatraPDF.exe");
            if (File.Exists(pfSumatra)) return pfSumatra;

            string pfx86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
            string pfx86Sumatra = Path.Combine(pfx86, "SumatraPDF", "SumatraPDF.exe");
            if (File.Exists(pfx86Sumatra)) return pfx86Sumatra;

            return null;
        }

        private void OpenAdmin()
        {
            string url = "https://printgo-admin.pages.dev";
            try
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = url,
                    UseShellExecute = true
                });
            }
            catch (Exception ex)
            {
                MessageBox.Show("Could not open browser: " + ex.Message + "\n\nPlease visit: " + url, "Shop Admin");
            }
        }

        private void InitializeComponent()
        {
            Text = "PrintGo Command Center";
            Size = new Size(580, 680);
            StartPosition = FormStartPosition.CenterScreen;
            FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false;
            BackColor = Color.FromArgb(248, 250, 252);
            Font = new Font("Segoe UI", 9.5f, FontStyle.Regular);

            var mainPanel = new Panel
            {
                Dock = DockStyle.Fill,
                Padding = new Padding(24),
                AutoScroll = true
            };
            Controls.Add(mainPanel);

            int y = 20;

            // Header Banner
            lblShopTitle = new Label
            {
                Text = "PrintGo Command Center",
                Font = new Font("Segoe UI", 16f, FontStyle.Bold),
                ForeColor = Color.FromArgb(15, 23, 42),
                Location = new Point(24, y),
                Size = new Size(340, 32)
            };
            mainPanel.Controls.Add(lblShopTitle);

            lblStatusBadge = new Label
            {
                Text = "● Checking...",
                Font = new Font("Segoe UI", 10.5f, FontStyle.Bold),
                ForeColor = Color.FromArgb(100, 116, 139),
                TextAlign = ContentAlignment.MiddleRight,
                Location = new Point(370, y + 2),
                Size = new Size(160, 28)
            };
            mainPanel.Controls.Add(lblStatusBadge);

            y += 34;

            lblAgentVersion = new Label
            {
                Text = "Agent Version: Detecting...",
                Font = new Font("Segoe UI", 8.5f, FontStyle.Regular),
                ForeColor = Color.FromArgb(148, 163, 184),
                Location = new Point(24, y),
                Size = new Size(340, 18)
            };
            mainPanel.Controls.Add(lblAgentVersion);

            y += 24;

            lblServer = new Label
            {
                Text = "Server: Connecting to Cloudflare Worker API...",
                ForeColor = Color.FromArgb(100, 116, 139),
                Location = new Point(24, y),
                Size = new Size(510, 22)
            };
            mainPanel.Controls.Add(lblServer);

            y += 30;

            // Section 1: System Readiness & Diagnostics Card
            var cardDiag = CreateCardPanel(24, y, 510, 80);
            mainPanel.Controls.Add(cardDiag);

            var lblDiagHeader = new Label
            {
                Text = "SYSTEM DEPENDENCIES & SECURITY",
                Font = new Font("Segoe UI", 8f, FontStyle.Bold),
                ForeColor = Color.FromArgb(100, 116, 139),
                Location = new Point(14, 10),
                Size = new Size(240, 16)
            };
            cardDiag.Controls.Add(lblDiagHeader);

            lblSumatraStatus = new Label
            {
                Text = "Checking SumatraPDF engine...",
                Font = new Font("Segoe UI", 9f, FontStyle.Regular),
                ForeColor = Color.FromArgb(71, 85, 105),
                Location = new Point(14, 30),
                Size = new Size(480, 20)
            };
            cardDiag.Controls.Add(lblSumatraStatus);

            lblDpapiStatus = new Label
            {
                Text = "Checking Windows DPAPI credentials...",
                Font = new Font("Segoe UI", 9f, FontStyle.Regular),
                ForeColor = Color.FromArgb(71, 85, 105),
                Location = new Point(14, 52),
                Size = new Size(480, 20)
            };
            cardDiag.Controls.Add(lblDpapiStatus);

            y += 92;

            // Section 2: Printer Status Card
            var cardPrinter = CreateCardPanel(24, y, 510, 115);
            mainPanel.Controls.Add(cardPrinter);

            var lblPrinterHeader = new Label
            {
                Text = "PHYSICAL PRODUCTION PRINTER",
                Font = new Font("Segoe UI", 8f, FontStyle.Bold),
                ForeColor = Color.FromArgb(100, 116, 139),
                Location = new Point(14, 10),
                Size = new Size(240, 16)
            };
            cardPrinter.Controls.Add(lblPrinterHeader);

            lblPrinterName = new Label
            {
                Text = "Scanning physical printers...",
                Font = new Font("Segoe UI", 12f, FontStyle.Bold),
                ForeColor = Color.FromArgb(30, 41, 59),
                Location = new Point(14, 30),
                Size = new Size(480, 28)
            };
            cardPrinter.Controls.Add(lblPrinterName);

            lblPrinterStatus = new Label
            {
                Text = "Printer Status: Detecting...",
                ForeColor = Color.FromArgb(71, 85, 105),
                Location = new Point(14, 62),
                Size = new Size(330, 24)
            };
            cardPrinter.Controls.Add(lblPrinterStatus);

            btnCheckPrinter = new Button
            {
                Text = "Windows Printers",
                Location = new Point(360, 58),
                Size = new Size(135, 30),
                BackColor = Color.White,
                FlatStyle = FlatStyle.System
            };
            btnCheckPrinter.Click += (s, e) => Process.Start("ms-settings:printers");
            cardPrinter.Controls.Add(btnCheckPrinter);

            y += 127;

            // Section 3: Order Activity Card
            var cardActivity = CreateCardPanel(24, y, 510, 85);
            mainPanel.Controls.Add(cardActivity);

            var lblActivityHeader = new Label
            {
                Text = "LIVE PRINT ACTIVITY",
                Font = new Font("Segoe UI", 8f, FontStyle.Bold),
                ForeColor = Color.FromArgb(100, 116, 139),
                Location = new Point(14, 10),
                Size = new Size(240, 16)
            };
            cardActivity.Controls.Add(lblActivityHeader);

            lblLastPrint = new Label
            {
                Text = "Ready for customer orders.",
                Font = new Font("Segoe UI", 10f, FontStyle.Regular),
                ForeColor = Color.FromArgb(30, 41, 59),
                Location = new Point(14, 30),
                Size = new Size(480, 24)
            };
            cardActivity.Controls.Add(lblLastPrint);

            lblLastHeartbeat = new Label
            {
                Text = "Last synchronized: None",
                ForeColor = Color.FromArgb(148, 163, 184),
                Location = new Point(14, 56),
                Size = new Size(480, 20)
            };
            cardActivity.Controls.Add(lblLastHeartbeat);

            y += 98;

            // Section 4: Agent Process Controls
            btnStartAgent = new Button
            {
                Text = "▶ Start Agent",
                Location = new Point(24, y),
                Size = new Size(160, 40),
                Font = new Font("Segoe UI", 10f, FontStyle.Bold),
                BackColor = Color.FromArgb(34, 197, 94),
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat
            };
            btnStartAgent.FlatAppearance.BorderSize = 0;
            btnStartAgent.Click += (s, e) => StartAgentManual();
            mainPanel.Controls.Add(btnStartAgent);

            btnStopAgent = new Button
            {
                Text = "⏹ Stop Agent",
                Location = new Point(198, y),
                Size = new Size(160, 40),
                Font = new Font("Segoe UI", 10f, FontStyle.Bold),
                BackColor = Color.FromArgb(239, 68, 68),
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat
            };
            btnStopAgent.FlatAppearance.BorderSize = 0;
            btnStopAgent.Click += (s, e) => StopAgentManual();
            mainPanel.Controls.Add(btnStopAgent);

            btnRestartAgent = new Button
            {
                Text = "🔄 Restart Agent",
                Location = new Point(374, y),
                Size = new Size(160, 40),
                Font = new Font("Segoe UI", 10f, FontStyle.Regular),
                BackColor = Color.White,
                FlatStyle = FlatStyle.System
            };
            btnRestartAgent.Click += (s, e) => RestartAgentManual();
            mainPanel.Controls.Add(btnRestartAgent);

            y += 50;

            // Section 5: Portal & Pairing
            btnOpenAdmin = new Button
            {
                Text = "🌐 Open Admin Portal",
                Location = new Point(24, y),
                Size = new Size(250, 40),
                Font = new Font("Segoe UI", 10f, FontStyle.Bold),
                BackColor = Color.FromArgb(37, 99, 235),
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat
            };
            btnOpenAdmin.FlatAppearance.BorderSize = 0;
            btnOpenAdmin.Click += (s, e) => OpenAdmin();
            mainPanel.Controls.Add(btnOpenAdmin);

            btnPair = new Button
            {
                Text = "🔗 Pair / Re-pair PC",
                Location = new Point(284, y),
                Size = new Size(250, 40),
                BackColor = Color.White,
                FlatStyle = FlatStyle.System
            };
            btnPair.Click += (s, e) => PromptPairing();
            mainPanel.Controls.Add(btnPair);

            y += 48;

            // Section 6: Diagnostics & Troubleshooting Row
            btnCopyDiag = new Button
            {
                Text = "📋 Copy Diagnostics",
                Location = new Point(24, y),
                Size = new Size(160, 36),
                BackColor = Color.White,
                FlatStyle = FlatStyle.System
            };
            btnCopyDiag.Click += (s, e) => CopyDiagnosticSummary();
            mainPanel.Controls.Add(btnCopyDiag);

            btnOpenLogs = new Button
            {
                Text = "📂 View Logs",
                Location = new Point(198, y),
                Size = new Size(160, 36),
                BackColor = Color.White,
                FlatStyle = FlatStyle.System
            };
            btnOpenLogs.Click += (s, e) => OpenLogsFolder();
            mainPanel.Controls.Add(btnOpenLogs);

            btnSupportPackage = new Button
            {
                Text = "📦 Support Package",
                Location = new Point(374, y),
                Size = new Size(160, 36),
                BackColor = Color.White,
                FlatStyle = FlatStyle.System
            };
            btnSupportPackage.Click += (s, e) => GenerateSupportPackage();
            mainPanel.Controls.Add(btnSupportPackage);
        }

        private Panel CreateCardPanel(int x, int y, int width, int height)
        {
            return new Panel
            {
                Location = new Point(x, y),
                Size = new Size(width, height),
                BackColor = Color.White,
                BorderStyle = BorderStyle.FixedSingle
            };
        }

        private void SetupTray()
        {
            trayMenu = new ContextMenuStrip();
            trayMenu.Items.Add("Open Command Center", null, (s, e) => RestoreWindow());
            trayMenu.Items.Add("Open Admin Portal", null, (s, e) => OpenAdmin());
            trayMenu.Items.Add("-");
            trayMenu.Items.Add("Start Agent", null, (s, e) => StartAgentManual());
            trayMenu.Items.Add("Stop Agent", null, (s, e) => StopAgentManual());
            trayMenu.Items.Add("Restart Agent", null, (s, e) => RestartAgentManual());
            trayMenu.Items.Add("-");
            trayMenu.Items.Add("Exit Command Center", null, (s, e) => ExitApplication());

            trayIcon = new NotifyIcon
            {
                Text = "PrintGo Command Center",
                Icon = SystemIcons.Application,
                ContextMenuStrip = trayMenu,
                Visible = true
            };
            trayIcon.DoubleClick += (s, e) => RestoreWindow();
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (e.CloseReason == CloseReason.UserClosing)
            {
                e.Cancel = true;
                WindowState = FormWindowState.Minimized;
                ShowInTaskbar = false;
                Hide();
                trayIcon.ShowBalloonTip(2000, "PrintGo is running", "PrintGo remains active in the system tray to process prints.", ToolTipIcon.Info);
            }
            base.OnFormClosing(e);
        }

        private void RestoreWindow()
        {
            Show();
            WindowState = FormWindowState.Normal;
            ShowInTaskbar = true;
            BringToFront();
        }

        private void ExitApplication()
        {
            refreshTimer.Stop();
            trayIcon.Visible = false;
            Application.Exit();
        }

        private void EnsureSingleAgentRunning()
        {
            var processes = Process.GetProcessesByName("PrintGo-Agent");
            if (processes.Length > 1)
            {
                // Strict invariant: exactly ONE agent process permitted
                for (int i = 1; i < processes.Length; i++)
                {
                    try { processes[i].Kill(); } catch { }
                }
            }
            else if (processes.Length == 0 && File.Exists(agentExePath))
            {
                StartAgentProcess();
            }
        }

        private void StartAgentProcess()
        {
            try
            {
                var startInfo = new ProcessStartInfo
                {
                    FileName = agentExePath,
                    CreateNoWindow = true,
                    UseShellExecute = false,
                    WindowStyle = ProcessWindowStyle.Hidden,
                    WorkingDirectory = Path.GetDirectoryName(agentExePath)
                };
                Process.Start(startInfo);
            }
            catch { }
        }

        private void StartAgentManual()
        {
            var existing = Process.GetProcessesByName("PrintGo-Agent");
            if (existing.Length > 0)
            {
                MessageBox.Show("PrintGo Agent is already running.", "Agent Running", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }

            if (!File.Exists(agentExePath))
            {
                MessageBox.Show("PrintGo-Agent.exe was not found at:\n" + agentExePath, "Missing Executable", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }

            StartAgentProcess();
            System.Threading.Thread.Sleep(500);
            RefreshStatus();

            if (trayIcon != null)
            {
                trayIcon.ShowBalloonTip(2000, "PrintGo Agent", "PrintGo Agent has been started.", ToolTipIcon.Info);
            }
        }

        private void StopAgentManual()
        {
            var existing = Process.GetProcessesByName("PrintGo-Agent");
            if (existing.Length == 0)
            {
                MessageBox.Show("PrintGo Agent is not currently running.", "Agent Inactive", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }

            if (Process.GetProcessesByName("SumatraPDF").Length > 0)
            {
                var confirm = MessageBox.Show(
                    "A document is actively printing right now. Stopping the Agent now may disrupt the active print.\n\nAre you sure you want to stop?",
                    "Warning: Printing in Progress",
                    MessageBoxButtons.YesNo,
                    MessageBoxIcon.Warning
                );
                if (confirm != DialogResult.Yes) return;
            }

            foreach (var proc in existing)
            {
                try
                {
                    proc.Kill();
                    proc.WaitForExit(3000);
                }
                catch { }
            }

            System.Threading.Thread.Sleep(300);
            RefreshStatus();

            if (trayIcon != null)
            {
                trayIcon.ShowBalloonTip(2000, "PrintGo Agent", "PrintGo Agent has been stopped.", ToolTipIcon.Info);
            }
        }

        private void RestartAgentManual()
        {
            if (Process.GetProcessesByName("SumatraPDF").Length > 0)
            {
                MessageBox.Show(
                    "A document is actively printing right now. Please wait until printing completes before restarting.",
                    "Printing in Progress",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information
                );
                return;
            }

            var confirm = MessageBox.Show(
                "Are you sure you want to safely restart the PrintGo Agent?",
                "Confirm Restart",
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Question
            );
            if (confirm != DialogResult.Yes) return;

            try
            {
                string journalPath = Path.Combine(appDataDir, "active-print.json");
                if (File.Exists(journalPath))
                {
                    var info = new FileInfo(journalPath);
                    if ((DateTime.UtcNow - info.LastWriteTimeUtc).TotalMinutes > 2)
                    {
                        File.Delete(journalPath);
                    }
                }
            }
            catch { }

            var existing = Process.GetProcessesByName("PrintGo-Agent");
            foreach (var proc in existing)
            {
                try
                {
                    proc.Kill();
                    proc.WaitForExit(3000);
                }
                catch { }
            }

            StartAgentProcess();
            System.Threading.Thread.Sleep(500);
            RefreshStatus();

            if (trayIcon != null)
            {
                trayIcon.ShowBalloonTip(2000, "PrintGo Agent", "PrintGo Agent has been safely restarted.", ToolTipIcon.Info);
            }
        }

        private void OpenLogsFolder()
        {
            string logsDir = Path.Combine(appDataDir, "logs");
            string target = Directory.Exists(logsDir) ? logsDir : appDataDir;
            try
            {
                if (!Directory.Exists(target)) Directory.CreateDirectory(target);
                Process.Start("explorer.exe", target);
            }
            catch (Exception ex)
            {
                MessageBox.Show("Could not open logs folder: " + ex.Message, "Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private void CopyDiagnosticSummary()
        {
            try
            {
                string statusJson = File.Exists(statusFilePath) ? File.ReadAllText(statusFilePath) : "(No status file found)";
                string summary = string.Format(
                    "================ PRINTGO DIAGNOSTIC REPORT ================\r\n" +
                    "Generated: {0}\r\n" +
                    "Machine: {1} (OS: {2})\r\n" +
                    "Agent Binary: {3} (Exists: {4})\r\n" +
                    "SumatraPDF: {5} (Exists: {6})\r\n" +
                    "DPAPI Credentials: {7}\r\n" +
                    "Server URL: {8}\r\n" +
                    "Active Agent Processes: {9}\r\n" +
                    "Active Sumatra Processes: {10}\r\n\r\n" +
                    "--- AGENT STATUS SNAPSHOT ---\r\n{11}\r\n" +
                    "===========================================================",
                    DateTime.Now.ToString("u"),
                    Environment.MachineName,
                    Environment.OSVersion.VersionString,
                    agentExePath ?? "None",
                    File.Exists(agentExePath),
                    sumatraExePath ?? "Not Detected",
                    !string.IsNullOrEmpty(sumatraExePath) && File.Exists(sumatraExePath),
                    File.Exists(Path.Combine(appDataDir, "credentials.enc")) ? "Present (DPAPI Encrypted)" : "Missing (Unpaired)",
                    GetActiveServerUrl(),
                    Process.GetProcessesByName("PrintGo-Agent").Length,
                    Process.GetProcessesByName("SumatraPDF").Length,
                    statusJson
                );

                Clipboard.SetText(summary);
                MessageBox.Show("Diagnostic details copied to Windows Clipboard.", "Diagnostics Copied", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            catch (Exception ex)
            {
                MessageBox.Show("Failed to copy diagnostics: " + ex.Message, "Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private void GenerateSupportPackage()
        {
            if (!File.Exists(agentExePath))
            {
                MessageBox.Show("PrintGo-Agent.exe could not be found to generate diagnostics.", "Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }

            try
            {
                var psi = new ProcessStartInfo
                {
                    FileName = agentExePath,
                    Arguments = "--support-package",
                    CreateNoWindow = true,
                    UseShellExecute = false,
                    RedirectStandardOutput = true
                };
                var proc = Process.Start(psi);
                proc.StandardOutput.ReadToEnd();
                proc.WaitForExit();

                if (proc.ExitCode != 0) throw new InvalidOperationException("Diagnostic export failed.");
                string desktop = Environment.GetFolderPath(Environment.SpecialFolder.Desktop);
                Process.Start("explorer.exe", desktop);
                MessageBox.Show("Support diagnostic package created on your Desktop.", "Diagnostics Ready", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            catch (Exception ex)
            {
                MessageBox.Show("Failed to create support package: " + ex.Message, "Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private string GetActiveServerUrl()
        {
            if (!string.IsNullOrEmpty(currentServerUrl)) return currentServerUrl;

            try
            {
                if (File.Exists(statusFilePath))
                {
                    var data = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(statusFilePath));
                    if (data != null && data.ContainsKey("serverUrl") && data["serverUrl"] != null)
                    {
                        string s = Convert.ToString(data["serverUrl"]).Trim();
                        if (!string.IsNullOrEmpty(s)) return s;
                    }
                }
            }
            catch { }

            foreach (var dir in new[] { AppDomain.CurrentDomain.BaseDirectory, appDataDir })
            {
                try
                {
                    string cfgPath = Path.Combine(dir, "printgo-config.json");
                    if (File.Exists(cfgPath))
                    {
                        var data = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(cfgPath));
                        if (data != null)
                        {
                            if (data.ContainsKey("serverUrl") && data["serverUrl"] != null)
                                return Convert.ToString(data["serverUrl"]).Trim();
                            if (data.ContainsKey("apiUrl") && data["apiUrl"] != null)
                                return Convert.ToString(data["apiUrl"]).Trim();
                        }
                    }
                }
                catch { }
            }

            return "https://printgo-api.printgo-worker.workers.dev";
        }

        private void PromptPairing()
        {
            using (var dialog = new PairingDialog())
            {
                if (dialog.ShowDialog(this) == DialogResult.OK)
                {
                    HandlePairInput(dialog.EnteredValue);
                }
            }
        }

        private void HandlePairInput(string input)
        {
            if (string.IsNullOrWhiteSpace(input)) return;
            input = input.Trim();

            string code = null;
            string server = null;

            if (input.StartsWith("printgo://", StringComparison.OrdinalIgnoreCase))
            {
                try
                {
                    Uri uri;
                    if (Uri.TryCreate(input, UriKind.Absolute, out uri) && uri.Scheme == "printgo" && uri.Host == "connect")
                    {
                        var servers = Regex.Matches(uri.Query, @"[?&]server=([^&]+)");
                        var codes = Regex.Matches(uri.Query, @"[?&]code=([^&]+)");
                        if (servers.Count == 1 && codes.Count == 1)
                        {
                            server = Uri.UnescapeDataString(servers[0].Groups[1].Value);
                            code = Uri.UnescapeDataString(codes[0].Groups[1].Value);
                        }
                    }
                }
                catch { }
            }

            if (string.IsNullOrEmpty(code))
            {
                string clean = Regex.Replace(input.ToUpperInvariant(), @"[\s\-]", "");
                if (Regex.IsMatch(clean, @"^[A-Z0-9]{8}$"))
                {
                    code = clean.Substring(0, 4) + "-" + clean.Substring(4, 4);
                    server = GetActiveServerUrl();
                }
                else if (Regex.IsMatch(input.ToUpperInvariant(), @"^[A-Z0-9]{4}-[A-Z0-9]{4}$"))
                {
                    code = input.ToUpperInvariant();
                    server = GetActiveServerUrl();
                }
            }

            if (string.IsNullOrEmpty(code) || string.IsNullOrEmpty(server))
            {
                MessageBox.Show(
                    "Please enter a valid 8-digit pairing code (e.g. 7777-8888) from your shop Admin.",
                    "Invalid Pairing Code",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Warning
                );
                return;
            }

            ExecutePairing(code, server);
        }

        private void HandlePairUrl(string pairUrl)
        {
            HandlePairInput(pairUrl);
        }

        private void ExecutePairing(string code, string server)
        {
            if (!File.Exists(agentExePath))
            {
                MessageBox.Show("PrintGo-Agent.exe could not be found at:\n" + agentExePath, "Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }

            if (Process.GetProcessesByName("SumatraPDF").Length > 0)
            {
                MessageBox.Show(
                    "A document is actively printing right now. Please wait until printing completes before pairing.",
                    "Printing in Progress",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information
                );
                return;
            }

            foreach (var proc in Process.GetProcessesByName("PrintGo-Agent"))
            {
                try
                {
                    proc.Kill();
                    proc.WaitForExit(3000);
                }
                catch { }
            }

            try
            {
                string journalPath = Path.Combine(appDataDir, "active-print.json");
                if (File.Exists(journalPath)) File.Delete(journalPath);
            }
            catch { }

            Uri origin;
            if (!Regex.IsMatch(code, @"^[A-Z0-9]{4}-[A-Z0-9]{4}$") ||
                !Uri.TryCreate(server, UriKind.Absolute, out origin) || origin.Scheme != "https" ||
                origin.UserInfo != "" || origin.AbsolutePath != "/" || origin.Query != "" || origin.Fragment != "")
            {
                MessageBox.Show("The pairing code or server URL is invalid. Please try again.", "Connection Failed", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }

            string cleanServer = origin.GetLeftPart(UriPartial.Authority);
            string args = "--pair-only --pair " + code + " --server \"" + cleanServer + "\"";
            var psi = new ProcessStartInfo
            {
                FileName = agentExePath,
                Arguments = args,
                CreateNoWindow = true,
                UseShellExecute = false,
                RedirectStandardError = true,
                RedirectStandardOutput = true
            };

            using (var process = Process.Start(psi))
            {
                process.StandardOutput.ReadToEnd();
                process.StandardError.ReadToEnd();
                if (!process.WaitForExit(60000))
                {
                    try { process.Kill(); } catch { }
                    MessageBox.Show("Pairing timed out. Please check your internet connection and try again.", "Pairing Timeout", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    EnsureSingleAgentRunning();
                    return;
                }

                if (process.ExitCode != 0)
                {
                    MessageBox.Show(
                        "Pairing failed. The code may have expired (valid for 10 minutes) or has already been used.\n\nGenerate a fresh code from your shop Admin.",
                        "Pairing Unsuccessful",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Warning
                    );
                    EnsureSingleAgentRunning();
                    RefreshStatus();
                    return;
                }
            }

            currentServerUrl = cleanServer;
            EnsureSingleAgentRunning();
            System.Threading.Thread.Sleep(1000);
            RefreshStatus();

            MessageBox.Show(
                "Computer connected successfully!\n\nPrintGo Agent is now running and ready to receive print orders.",
                "PrintGo Connected",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information
            );
        }

        private void RefreshStatus()
        {
            sumatraExePath = FindSumatraExecutable();
            bool sumatraReady = !string.IsNullOrEmpty(sumatraExePath) && File.Exists(sumatraExePath);
            if (sumatraReady)
            {
                lblSumatraStatus.Text = "✓ SumatraPDF Engine Ready (" + Path.GetFileName(sumatraExePath) + ")";
                lblSumatraStatus.ForeColor = Color.FromArgb(22, 101, 52);
            }
            else
            {
                lblSumatraStatus.Text = "⚠️ SumatraPDF missing: Place SumatraPDF.exe in the same folder as Agent.";
                lblSumatraStatus.ForeColor = Color.FromArgb(194, 65, 12);
            }

            bool credsExist = File.Exists(Path.Combine(appDataDir, "credentials.enc"));
            if (credsExist)
            {
                lblDpapiStatus.Text = "✓ Shop Pairing Active (Encrypted via Windows DPAPI)";
                lblDpapiStatus.ForeColor = Color.FromArgb(22, 101, 52);
            }
            else
            {
                lblDpapiStatus.Text = "⚠️ Not paired with shop Admin. Click 'Pair / Re-pair PC'.";
                lblDpapiStatus.ForeColor = Color.FromArgb(194, 65, 12);
            }

            lblPrinterName.Text = "Printer readiness not verified";
            lblPrinterStatus.Text = "Check production printer in Admin";
            lblLastHeartbeat.Text = "No recent heartbeat";
            lblStatusBadge.Text = "Offline / starting";
            lblStatusBadge.ForeColor = Color.FromArgb(239, 68, 68);
            trayIcon.Text = "PrintGo - status unavailable";

            var agentProcs = Process.GetProcessesByName("PrintGo-Agent");
            bool isAgentRunning = agentProcs.Length > 0;
            btnStartAgent.Enabled = !isAgentRunning;
            btnStopAgent.Enabled = isAgentRunning;
            btnRestartAgent.Enabled = isAgentRunning;

            try
            {
                if (File.Exists(statusFilePath))
                {
                    var data = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(statusFilePath));
                    string state = Convert.ToString(data["operationalState"]);
                    double heartbeat = data["lastHeartbeatMs"] == null ? 0 : Convert.ToDouble(data["lastHeartbeatMs"]);
                    double now = (DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds;
                    bool fresh = heartbeat > 0 && now >= heartbeat && now - heartbeat < 90000 && isAgentRunning;
                    lblStatusBadge.Text = fresh ? state : (isAgentRunning ? "Reconnecting..." : "Offline / stopped");
                    if (fresh && state == "ONLINE")
                    {
                        lblStatusBadge.ForeColor = Color.FromArgb(34, 197, 94);
                    }
                    else if (fresh)
                    {
                        lblStatusBadge.ForeColor = Color.FromArgb(234, 179, 8);
                    }
                    else
                    {
                        lblStatusBadge.ForeColor = Color.FromArgb(239, 68, 68);
                    }

                    if (data.ContainsKey("agentVersion") && data["agentVersion"] != null)
                    {
                        lblAgentVersion.Text = "Agent Version: v" + Convert.ToString(data["agentVersion"]);
                    }

                    if (data.ContainsKey("displayName") && data["displayName"] != null)
                    {
                        lblShopTitle.Text = Convert.ToString(data["displayName"]);
                    }

                    if (data.ContainsKey("serverUrl") && data["serverUrl"] != null)
                    {
                        currentServerUrl = Convert.ToString(data["serverUrl"]).Trim();
                        lblServer.Text = "Server: " + currentServerUrl;
                    }
                    else
                    {
                        lblServer.Text = "Server: " + GetActiveServerUrl();
                    }

                    if (heartbeat > 0)
                    {
                        lblLastHeartbeat.Text = "Last heartbeat: " +
                            new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddMilliseconds(heartbeat).ToLocalTime().ToString("g");
                    }

                    if (data.ContainsKey("printers") && data["printers"] is System.Collections.ArrayList)
                    {
                        var list = (System.Collections.ArrayList)data["printers"];
                        string foundPrinter = null;
                        int eligibleCount = 0;
                        foreach (var item in list)
                        {
                            if (item is Dictionary<string, object>)
                            {
                                var p = (Dictionary<string, object>)item;
                                bool isEligible = p.ContainsKey("isEligible") && Convert.ToBoolean(p["isEligible"]);
                                bool isDef = p.ContainsKey("isDefault") && Convert.ToBoolean(p["isDefault"]);
                                string dName = p.ContainsKey("displayName") ? Convert.ToString(p["displayName"]) : "";
                                string pStatus = p.ContainsKey("status") ? Convert.ToString(p["status"]) : "UNKNOWN";

                                if (isEligible)
                                {
                                    eligibleCount++;
                                    if (isDef)
                                    {
                                        foundPrinter = dName + " [★ Default, " + pStatus + "]";
                                    }
                                    else if (foundPrinter == null)
                                    {
                                        foundPrinter = dName + " [" + pStatus + "]";
                                    }
                                }
                            }
                        }

                        if (foundPrinter != null)
                        {
                            lblPrinterName.Text = foundPrinter;
                            lblPrinterStatus.Text = string.Format("Ready ({0} physical printer{1} online)", eligibleCount, eligibleCount == 1 ? "" : "s");
                        }
                        else
                        {
                            lblPrinterName.Text = "No eligible production printer";
                            lblPrinterStatus.Text = "Configure default printer in Admin Portal";
                        }
                    }

                    if (data.ContainsKey("lastJobCode") && data["lastJobCode"] != null)
                    {
                        string jobCode = Convert.ToString(data["lastJobCode"]);
                        string jobStatus = data.ContainsKey("lastJobStatus") ? Convert.ToString(data["lastJobStatus"]) : "";
                        lblLastPrint.Text = "Last Order: " + jobCode + (string.IsNullOrEmpty(jobStatus) ? "" : " (" + jobStatus + ")");
                    }

                    string trayText = "PrintGo - " + lblStatusBadge.Text;
                    trayIcon.Text = trayText.Substring(0, Math.Min(63, trayText.Length));
                }
            }
            catch { /* Keep the unavailable state; never crash on parse */ }
        }
    }

    public class PairingDialog : Form
    {
        private TextBox txtCode;
        private Button btnConnect;
        private Button btnCancel;
        public string EnteredValue { get; private set; }

        public PairingDialog()
        {
            Text = "Connect PrintGo Computer";
            Size = new Size(460, 260);
            StartPosition = FormStartPosition.CenterParent;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            BackColor = Color.FromArgb(248, 250, 252);
            Font = new Font("Segoe UI", 9.5f, FontStyle.Regular);

            var lblHeader = new Label
            {
                Text = "Enter Pairing Code",
                Font = new Font("Segoe UI", 13f, FontStyle.Bold),
                ForeColor = Color.FromArgb(15, 23, 42),
                Location = new Point(24, 20),
                Size = new Size(400, 28)
            };
            Controls.Add(lblHeader);

            var lblSubtitle = new Label
            {
                Text = "Enter the 8-character code from Admin (e.g. 7777-8888):\r\nLowercase letters are automatically converted to uppercase.",
                ForeColor = Color.FromArgb(100, 116, 139),
                Location = new Point(24, 52),
                Size = new Size(400, 38)
            };
            Controls.Add(lblSubtitle);

            txtCode = new TextBox
            {
                Location = new Point(24, 100),
                Size = new Size(396, 36),
                Font = new Font("Consolas", 16f, FontStyle.Bold),
                TextAlign = HorizontalAlignment.Center,
                CharacterCasing = CharacterCasing.Upper
            };
            Controls.Add(txtCode);

            btnCancel = new Button
            {
                Text = "Cancel",
                DialogResult = DialogResult.Cancel,
                Location = new Point(190, 156),
                Size = new Size(110, 38),
                BackColor = Color.White,
                FlatStyle = FlatStyle.System
            };
            Controls.Add(btnCancel);

            btnConnect = new Button
            {
                Text = "Connect PC",
                DialogResult = DialogResult.OK,
                Location = new Point(310, 156),
                Size = new Size(110, 38),
                BackColor = Color.FromArgb(37, 99, 235),
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat,
                Font = new Font("Segoe UI", 10f, FontStyle.Bold)
            };
            btnConnect.FlatAppearance.BorderSize = 0;
            btnConnect.Click += (s, e) =>
            {
                EnteredValue = txtCode.Text.Trim();
                DialogResult = DialogResult.OK;
                Close();
            };
            Controls.Add(btnConnect);

            AcceptButton = btnConnect;
            CancelButton = btnCancel;
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            txtCode.Focus();
        }
    }
}

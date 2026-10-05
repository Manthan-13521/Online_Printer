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
        private Label lblStatusBadge;
        private Label lblServer;
        private Label lblPrinterName;
        private Label lblPrinterStatus;
        private Label lblLastHeartbeat;
        private Label lblLastPrint;
        private Button btnOpenAdmin;
        private Button btnCheckPrinter;
        private Button btnRestartAgent;
        private Button btnSupportPackage;
        private Button btnPair;

        private string currentServerUrl = null;
        private string appDataDir;
        private string statusFilePath;
        private string agentExePath;

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

            InitializeComponent();
            SetupTray();

            if (!string.IsNullOrEmpty(pairUrl))
            {
                HandlePairUrl(pairUrl);
            }

            EnsureAgentRunning();
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
            Text = "PrintGo Control Center";
            Size = new Size(540, 520);
            StartPosition = FormStartPosition.CenterScreen;
            FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false;
            BackColor = Color.FromArgb(248, 250, 252);
            Font = new Font("Segoe UI", 9.5f, FontStyle.Regular);

            var mainPanel = new Panel
            {
                Dock = DockStyle.Fill,
                Padding = new Padding(24)
            };
            Controls.Add(mainPanel);

            int y = 20;

            // Header Banner
            lblShopTitle = new Label
            {
                Text = "PrintGo Shop Operations",
                Font = new Font("Segoe UI", 16f, FontStyle.Bold),
                ForeColor = Color.FromArgb(15, 23, 42),
                Location = new Point(24, y),
                Size = new Size(340, 36)
            };
            mainPanel.Controls.Add(lblShopTitle);

            lblStatusBadge = new Label
            {
                Text = "● Checking...",
                Font = new Font("Segoe UI", 10.5f, FontStyle.Bold),
                ForeColor = Color.FromArgb(100, 116, 139),
                TextAlign = ContentAlignment.MiddleRight,
                Location = new Point(370, y + 4),
                Size = new Size(130, 28)
            };
            mainPanel.Controls.Add(lblStatusBadge);

            y += 45;

            lblServer = new Label
            {
                Text = "Server: Connecting...",
                ForeColor = Color.FromArgb(100, 116, 139),
                Location = new Point(24, y),
                Size = new Size(470, 24)
            };
            mainPanel.Controls.Add(lblServer);

            y += 35;

            // Section 1: Printer Status Card
            var cardPrinter = CreateCardPanel(24, y, 476, 120);
            mainPanel.Controls.Add(cardPrinter);

            var lblPrinterHeader = new Label
            {
                Text = "PRODUCTION PRINTER",
                Font = new Font("Segoe UI", 8f, FontStyle.Bold),
                ForeColor = Color.FromArgb(100, 116, 139),
                Location = new Point(16, 12),
                Size = new Size(200, 18)
            };
            cardPrinter.Controls.Add(lblPrinterHeader);

            lblPrinterName = new Label
            {
                Text = "Scanning physical printers...",
                Font = new Font("Segoe UI", 12f, FontStyle.Bold),
                ForeColor = Color.FromArgb(30, 41, 59),
                Location = new Point(16, 32),
                Size = new Size(440, 30)
            };
            cardPrinter.Controls.Add(lblPrinterName);

            lblPrinterStatus = new Label
            {
                Text = "Printer Status: Detecting...",
                ForeColor = Color.FromArgb(71, 85, 105),
                Location = new Point(16, 68),
                Size = new Size(300, 24)
            };
            cardPrinter.Controls.Add(lblPrinterStatus);

            btnCheckPrinter = new Button
            {
                Text = "Printer Settings",
                Location = new Point(330, 64),
                Size = new Size(130, 32),
                BackColor = Color.White,
                FlatStyle = FlatStyle.System
            };
            btnCheckPrinter.Click += (s, e) => Process.Start("ms-settings:printers");
            cardPrinter.Controls.Add(btnCheckPrinter);

            y += 135;

            // Section 2: Order Activity Card
            var cardActivity = CreateCardPanel(24, y, 476, 95);
            mainPanel.Controls.Add(cardActivity);

            var lblActivityHeader = new Label
            {
                Text = "LATEST PRINT ACTIVITY",
                Font = new Font("Segoe UI", 8f, FontStyle.Bold),
                ForeColor = Color.FromArgb(100, 116, 139),
                Location = new Point(16, 12),
                Size = new Size(200, 18)
            };
            cardActivity.Controls.Add(lblActivityHeader);

            lblLastPrint = new Label
            {
                Text = "Ready for customer orders.",
                Font = new Font("Segoe UI", 10.5f, FontStyle.Regular),
                ForeColor = Color.FromArgb(30, 41, 59),
                Location = new Point(16, 34),
                Size = new Size(440, 24)
            };
            cardActivity.Controls.Add(lblLastPrint);

            lblLastHeartbeat = new Label
            {
                Text = "Last synchronized: None",
                ForeColor = Color.FromArgb(148, 163, 184),
                Location = new Point(16, 60),
                Size = new Size(440, 22)
            };
            cardActivity.Controls.Add(lblLastHeartbeat);

            y += 110;

            // Section 3: Action Buttons
            btnOpenAdmin = new Button
            {
                Text = "🌐 Open Admin Portal",
                Location = new Point(24, y),
                Size = new Size(230, 44),
                Font = new Font("Segoe UI", 10f, FontStyle.Bold),
                BackColor = Color.FromArgb(37, 99, 235),
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat
            };
            btnOpenAdmin.FlatAppearance.BorderSize = 0;
            btnOpenAdmin.Click += (s, e) => OpenAdmin();
            mainPanel.Controls.Add(btnOpenAdmin);

            btnRestartAgent = new Button
            {
                Text = "Start PrintGo",
                Location = new Point(270, y),
                Size = new Size(230, 44),
                Font = new Font("Segoe UI", 10f, FontStyle.Regular),
                BackColor = Color.White,
                FlatStyle = FlatStyle.System
            };
            btnRestartAgent.Click += (s, e) => RestartAgent();
            mainPanel.Controls.Add(btnRestartAgent);

            y += 55;

            btnSupportPackage = new Button
            {
                Text = "📦 Create Support Package",
                Location = new Point(24, y),
                Size = new Size(230, 38),
                BackColor = Color.White,
                FlatStyle = FlatStyle.System
            };
            btnSupportPackage.Click += (s, e) => GenerateSupportPackage();
            mainPanel.Controls.Add(btnSupportPackage);

            btnPair = new Button
            {
                Text = "🔗 Pair / Re-pair PC",
                Location = new Point(270, y),
                Size = new Size(230, 38),
                BackColor = Color.White,
                FlatStyle = FlatStyle.System
            };
            btnPair.Click += (s, e) => PromptPairing();
            mainPanel.Controls.Add(btnPair);
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
            trayMenu.Items.Add("Open Control Center", null, (s, e) => RestoreWindow());
            trayMenu.Items.Add("Open Admin Portal", null, (s, e) => OpenAdmin());
            trayMenu.Items.Add("Start PrintGo", null, (s, e) => RestartAgent());
            trayMenu.Items.Add("-");
            trayMenu.Items.Add("Exit", null, (s, e) => ExitApplication());

            trayIcon = new NotifyIcon
            {
                Text = "PrintGo Control Center",
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

        private void EnsureAgentRunning()
        {
            var processes = Process.GetProcessesByName("PrintGo-Agent");
            if (processes.Length == 0 && File.Exists(agentExePath))
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
        }

        private void RestartAgent()
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
            bool hadRunning = existing.Length > 0;
            foreach (var proc in existing)
            {
                try
                {
                    proc.Kill();
                    proc.WaitForExit(3000);
                }
                catch { }
            }

            EnsureAgentRunning();
            System.Threading.Thread.Sleep(500);
            RefreshStatus();

            if (trayIcon != null)
            {
                trayIcon.ShowBalloonTip(
                    2000,
                    "PrintGo Agent",
                    hadRunning ? "PrintGo Agent has been restarted." : "PrintGo Agent has started.",
                    ToolTipIcon.Info
                );
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
                    EnsureAgentRunning();
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
                    EnsureAgentRunning();
                    RefreshStatus();
                    return;
                }
            }

            currentServerUrl = cleanServer;
            EnsureAgentRunning();
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
            lblPrinterName.Text = "Printer readiness not verified";
            lblPrinterStatus.Text = "Check production printer in Admin";
            lblLastHeartbeat.Text = "No recent heartbeat";
            lblStatusBadge.Text = "Offline / starting";
            lblStatusBadge.ForeColor = Color.FromArgb(239, 68, 68);
            trayIcon.Text = "PrintGo - status unavailable";

            var agentProcs = Process.GetProcessesByName("PrintGo-Agent");
            btnRestartAgent.Text = agentProcs.Length > 0 ? "Restart PrintGo" : "Start PrintGo";

            try
            {
                if (File.Exists(statusFilePath))
                {
                    var data = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(statusFilePath));
                    string state = Convert.ToString(data["operationalState"]);
                    double heartbeat = data["lastHeartbeatMs"] == null ? 0 : Convert.ToDouble(data["lastHeartbeatMs"]);
                    double now = (DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds;
                    bool fresh = heartbeat > 0 && now >= heartbeat && now - heartbeat < 90000 &&
                        agentProcs.Length > 0;
                    lblStatusBadge.Text = fresh ? state : (agentProcs.Length > 0 ? "Reconnecting..." : "Offline / stopped");
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
                        foreach (var item in list)
                        {
                            if (item is Dictionary<string, object>)
                            {
                                var p = (Dictionary<string, object>)item;
                                bool isEligible = p.ContainsKey("isEligible") && Convert.ToBoolean(p["isEligible"]);
                                bool isDef = p.ContainsKey("isDefault") && Convert.ToBoolean(p["isDefault"]);
                                string dName = p.ContainsKey("displayName") ? Convert.ToString(p["displayName"]) : "";
                                if (isEligible && isDef)
                                {
                                    foundPrinter = dName + " (Default)";
                                    break;
                                }
                                if (isEligible && foundPrinter == null)
                                {
                                    foundPrinter = dName;
                                }
                            }
                        }
                        if (foundPrinter != null)
                        {
                            lblPrinterName.Text = foundPrinter;
                            lblPrinterStatus.Text = "Production printer ready";
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
                Text = "Enter the 8-character code from Admin (e.g. 7777-8888):\nLowercase letters are automatically converted to uppercase.",
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

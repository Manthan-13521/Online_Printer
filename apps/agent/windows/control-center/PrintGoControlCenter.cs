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
            return Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "PrintGo-Agent.exe");
        }

        private void OpenAdmin()
        {
            if (currentServerUrl != null) Process.Start(currentServerUrl);
            else MessageBox.Show("Open the shop Admin bookmark provided by your installer technician.", "Shop Admin");
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
                        WindowStyle = ProcessWindowStyle.Hidden
                    };
                    Process.Start(startInfo);
                }
                catch { }
            }
        }

        private void RestartAgent()
        {
            if (MaintenanceBlocked())
            {
                MessageBox.Show("PrintGo is running or has an unresolved print. Restart is deferred. Ask your technician to arrange maintenance after all work is reconciled.", "Maintenance deferred");
                return;
            }
            EnsureAgentRunning();
            RefreshStatus();
        }

        private bool MaintenanceBlocked()
        {
            return Process.GetProcessesByName("PrintGo-Agent").Length > 0 ||
                Process.GetProcessesByName("SumatraPDF").Length > 0 ||
                File.Exists(Path.Combine(appDataDir, "active-print.json"));
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

        private void PromptPairing()
        {
            string link = Microsoft.VisualBasic.Interaction.InputBox(
                "Paste the full Connect Computer link from your shop Admin.", "Connect PrintGo", "");
            if (!string.IsNullOrWhiteSpace(link)) HandlePairUrl(link.Trim());
        }

        private void HandlePairUrl(string pairUrl)
        {
            try
            {
                Uri uri;
                if (!Uri.TryCreate(pairUrl, UriKind.Absolute, out uri) || uri.Scheme != "printgo" ||
                    uri.Host != "connect" || uri.UserInfo != "" || uri.Fragment != "")
                    throw new InvalidOperationException();
                var servers = Regex.Matches(uri.Query, @"[?&]server=([^&]+)");
                var codes = Regex.Matches(uri.Query, @"[?&]code=([^&]+)");
                if (servers.Count != 1 || codes.Count != 1) throw new InvalidOperationException();
                ExecutePairing(Uri.UnescapeDataString(codes[0].Groups[1].Value),
                    Uri.UnescapeDataString(servers[0].Groups[1].Value));
            }
            catch { MessageBox.Show("This connection link is invalid. Create a fresh link in your shop Admin.", "Connection failed"); }
        }

        private void ExecutePairing(string code, string server)
        {
            if (!File.Exists(agentExePath)) throw new InvalidOperationException();
            if (MaintenanceBlocked())
            {
                MessageBox.Show("Connection changes are deferred while PrintGo is running or a print remains unresolved. Ask your technician to arrange maintenance.", "Maintenance deferred");
                return;
            }
            Uri origin;
            if (!Regex.IsMatch(code, @"^[A-Z0-9]{4}-?[A-Z0-9]{4}$") ||
                !Uri.TryCreate(server, UriKind.Absolute, out origin) || origin.Scheme != "https" ||
                origin.UserInfo != "" || origin.AbsolutePath != "/" || origin.Query != "" || origin.Fragment != "")
                throw new InvalidOperationException();
            string args = "--pair-only --pair " + code + " --server \"" + origin.GetLeftPart(UriPartial.Authority) + "\"";
            var psi = new ProcessStartInfo {
                FileName = agentExePath, Arguments = args, CreateNoWindow = true, UseShellExecute = false
            };
            using (var process = Process.Start(psi))
            {
                if (!process.WaitForExit(60000))
                {
                    MessageBox.Show("Connection is still pending. Do not start another pairing attempt until this one finishes.", "Connection pending");
                    return;
                }
                if (process.ExitCode != 0) throw new InvalidOperationException();
            }
            EnsureAgentRunning();
            MessageBox.Show("Computer connected. Check printer readiness in Admin before accepting orders.", "Connected");
        }

        private void RefreshStatus()
        {
            lblPrinterName.Text = "Printer readiness not verified";
            lblPrinterStatus.Text = "Check production printer in Admin";
            lblLastHeartbeat.Text = "No recent heartbeat";
            lblStatusBadge.Text = "Offline / starting";
            lblStatusBadge.ForeColor = Color.FromArgb(239, 68, 68);
            trayIcon.Text = "PrintGo - status unavailable";
            try
            {
                var data = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(statusFilePath));
                string state = Convert.ToString(data["operationalState"]);
                double heartbeat = data["lastHeartbeatMs"] == null ? 0 : Convert.ToDouble(data["lastHeartbeatMs"]);
                double now = (DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds;
                bool fresh = heartbeat > 0 && now >= heartbeat && now - heartbeat < 90000 &&
                    Process.GetProcessesByName("PrintGo-Agent").Length > 0;
                lblStatusBadge.Text = fresh ? state : "Offline / stale status";
                if (fresh && state == "ONLINE") lblStatusBadge.ForeColor = Color.FromArgb(34, 197, 94);
                lblShopTitle.Text = Convert.ToString(data["displayName"]) ?? "PrintGo";
                lblServer.Text = "Single-shop connection";
                if (heartbeat > 0) lblLastHeartbeat.Text = "Last heartbeat: " +
                    new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddMilliseconds(heartbeat).ToLocalTime().ToString("g");
                // A Windows default printer is not necessarily the Admin production printer.
                lblPrinterStatus.Text = "Production selection: confirm in Admin";
                string trayText = "PrintGo - " + lblStatusBadge.Text;
                trayIcon.Text = trayText.Substring(0, Math.Min(63, trayText.Length));
            }
            catch { /* Keep the unavailable state; never infer readiness. */ }
        }
    }
}

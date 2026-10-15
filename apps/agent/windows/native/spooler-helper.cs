using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace PrintGo.Native {
    class Program {
        [DllImport("winspool.drv", CharSet = CharSet.Auto, SetLastError = true)]
        public static extern bool OpenPrinter(string pPrinterName, out IntPtr phPrinter, IntPtr pDefault);

        [DllImport("winspool.drv", SetLastError = true)]
        public static extern bool ClosePrinter(IntPtr hPrinter);

        [DllImport("winspool.drv", CharSet = CharSet.Auto, SetLastError = true)]
        public static extern bool GetPrinter(IntPtr hPrinter, int Level, IntPtr pPrinter, int cbBuf, out int pcbNeeded);

        [DllImport("winspool.drv", CharSet = CharSet.Auto, SetLastError = true)]
        public static extern bool EnumJobs(IntPtr hPrinter, int FirstJob, int NoJobs, int Level, IntPtr pJob, int cbBuf, out int pcbNeeded, out int pcReturned);

        [DllImport("winspool.drv", CharSet = CharSet.Auto, SetLastError = true)]
        public static extern bool GetJob(IntPtr hPrinter, int JobId, int Level, IntPtr pJob, int cbBuf, out int pcbNeeded);

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
        public struct PRINTER_INFO_2 {
            public string pServerName;
            public string pPrinterName;
            public string pShareName;
            public string pPortName;
            public string pDriverName;
            public string pComment;
            public string pLocation;
            public IntPtr pDevMode;
            public string pSepFile;
            public string pPrintProcessor;
            public string pDatatype;
            public string pParameters;
            public IntPtr pSecurityDescriptor;
            public uint Attributes;
            public uint Priority;
            public uint DefaultPriority;
            public uint StartTime;
            public uint UntilTime;
            public uint Status;
            public uint cJobs;
            public uint AveragePPM;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
        public struct JOB_INFO_1 {
            public int JobId;
            public string pPrinterName;
            public string pMachineName;
            public string pUserName;
            public string pDocument;
            public string pDatatype;
            public string pStatus;
            public uint Status;
            public uint Priority;
            public uint Position;
            public uint TotalPages;
            public uint PagesPrinted;
            public System.Runtime.InteropServices.ComTypes.FILETIME Submitted;
        }

        const uint PRINTER_ATTRIBUTE_WORK_OFFLINE = 0x00000400;

        const uint PRINTER_STATUS_PAUSED            = 0x00000001;
        const uint PRINTER_STATUS_ERROR             = 0x00000002;
        const uint PRINTER_STATUS_PAPER_JAM         = 0x00000008;
        const uint PRINTER_STATUS_PAPER_OUT         = 0x00000010;
        const uint PRINTER_STATUS_OUTPUT_BIN_FULL   = 0x00000800;
        const uint PRINTER_STATUS_NOT_AVAILABLE     = 0x00001000;
        const uint PRINTER_STATUS_OFFLINE           = 0x00000080;
        const uint PRINTER_STATUS_DOOR_OPEN         = 0x00400000;
        const uint PRINTER_STATUS_TONER_LOW         = 0x00040000;
        const uint PRINTER_STATUS_NO_TONER          = 0x00080000;
        const uint PRINTER_STATUS_USER_INTERVENTION = 0x00100000;

        const uint JOB_STATUS_PAUSED            = 0x00000001;
        const uint JOB_STATUS_ERROR             = 0x00000002;
        const uint JOB_STATUS_DELETING          = 0x00000004;
        const uint JOB_STATUS_SPOOLING          = 0x00000008;
        const uint JOB_STATUS_PRINTING          = 0x00000010;
        const uint JOB_STATUS_OFFLINE           = 0x00000020;
        const uint JOB_STATUS_PAPEROUT          = 0x00000040;
        const uint JOB_STATUS_PRINTED           = 0x00000080;
        const uint JOB_STATUS_DELETED           = 0x00000100;
        const uint JOB_STATUS_BLOCKED_DEVQ      = 0x00000200;
        const uint JOB_STATUS_USER_INTERVENTION = 0x00000400;
        const uint JOB_STATUS_RESTART           = 0x00000800;
        const uint JOB_STATUS_COMPLETE          = 0x00001000;

        static string EscapeJson(string s) {
            if (s == null) return "";
            return s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "").Replace("\n", " ");
        }

        static int Main(string[] args) {
            if (args.Length < 2) {
                Console.WriteLine("{\"error\":\"Usage: spooler-helper.exe <status|jobs|job-status> <printerName> [jobId]\"}");
                return 1;
            }

            string command = args[0].ToLowerInvariant();
            string printerName = args[1];

            IntPtr hPrinter;
            if (!OpenPrinter(printerName, out hPrinter, IntPtr.Zero)) {
                int err = Marshal.GetLastWin32Error();
                Console.WriteLine("{{\"error\":\"Printer not found or access denied\", \"code\":{0}}}", err);
                return 2;
            }

            try {
                if (command == "status") {
                    return HandleStatus(hPrinter, printerName);
                } else if (command == "jobs") {
                    return HandleJobs(hPrinter);
                } else if (command == "job-status") {
                    if (args.Length < 3) {
                        Console.WriteLine("{\"error\":\"jobId is required for job-status\"}");
                        return 1;
                    }
                    int targetJobId;
                    if (!int.TryParse(args[2], out targetJobId)) {
                        Console.WriteLine("{\"state\":\"UNKNOWN\",\"message\":\"Invalid non-numeric job ID\"}");
                        return 0;
                    }
                    return HandleJobStatus(hPrinter, targetJobId);
                } else {
                    Console.WriteLine("{{\"error\":\"Unknown command: {0}\"}}", EscapeJson(command));
                    return 1;
                }
            } finally {
                ClosePrinter(hPrinter);
            }
        }

        static int HandleStatus(IntPtr hPrinter, string printerName) {
            int needed;
            GetPrinter(hPrinter, 2, IntPtr.Zero, 0, out needed);
            if (needed <= 0) {
                Console.WriteLine("{\"availability\":\"UNKNOWN\",\"message\":\"Failed to query printer buffer size\"}");
                return 0;
            }

            IntPtr pBuf = Marshal.AllocHGlobal(needed);
            try {
                if (!GetPrinter(hPrinter, 2, pBuf, needed, out needed)) {
                    Console.WriteLine("{\"availability\":\"UNKNOWN\",\"message\":\"GetPrinter failed\"}");
                    return 0;
                }

                var info = (PRINTER_INFO_2)Marshal.PtrToStructure(pBuf, typeof(PRINTER_INFO_2));
                string availability = "ONLINE";
                string message = "Printer is ready";

                if ((info.Attributes & PRINTER_ATTRIBUTE_WORK_OFFLINE) != 0) {
                    availability = "OFFLINE";
                    message = "Printer is set to work offline";
                } else if ((info.Status & PRINTER_STATUS_PAPER_OUT) != 0) {
                    availability = "BLOCKED";
                    message = "Out of Paper";
                } else if ((info.Status & PRINTER_STATUS_PAPER_JAM) != 0) {
                    availability = "BLOCKED";
                    message = "Paper Jam";
                } else if ((info.Status & PRINTER_STATUS_DOOR_OPEN) != 0) {
                    availability = "BLOCKED";
                    message = "Door or Cover Open";
                } else if ((info.Status & PRINTER_STATUS_NO_TONER) != 0) {
                    availability = "BLOCKED";
                    message = "Out of Toner";
                } else if ((info.Status & PRINTER_STATUS_OUTPUT_BIN_FULL) != 0) {
                    availability = "BLOCKED";
                    message = "Output Bin Full";
                } else if ((info.Status & PRINTER_STATUS_USER_INTERVENTION) != 0) {
                    availability = "BLOCKED";
                    message = "User intervention required";
                } else if ((info.Status & PRINTER_STATUS_PAUSED) != 0) {
                    availability = "BLOCKED";
                    message = "Printer queue is paused";
                } else if ((info.Status & (PRINTER_STATUS_ERROR | PRINTER_STATUS_NOT_AVAILABLE | PRINTER_STATUS_OFFLINE)) != 0) {
                    availability = "OFFLINE";
                    message = "Printer is offline or in error state";
                }

                Console.WriteLine("{{\"availability\":\"{0}\",\"message\":\"{1}\",\"status\":{2},\"attributes\":{3},\"cJobs\":{4},\"port\":\"{5}\",\"driver\":\"{6}\"}}",
                    availability, EscapeJson(message), info.Status, info.Attributes, info.cJobs, EscapeJson(info.pPortName), EscapeJson(info.pDriverName));
                return 0;
            } finally {
                Marshal.FreeHGlobal(pBuf);
            }
        }

        static int HandleJobs(IntPtr hPrinter) {
            int needed, returned;
            EnumJobs(hPrinter, 0, 100, 1, IntPtr.Zero, 0, out needed, out returned);
            if (needed <= 0 || returned == 0) {
                Console.WriteLine("[]");
                return 0;
            }

            IntPtr pBuf = Marshal.AllocHGlobal(needed);
            try {
                if (!EnumJobs(hPrinter, 0, 100, 1, pBuf, needed, out needed, out returned)) {
                    Console.WriteLine("[]");
                    return 0;
                }

                var sb = new StringBuilder();
                sb.Append("[");
                int structSize = Marshal.SizeOf(typeof(JOB_INFO_1));
                for (int i = 0; i < returned; i++) {
                    IntPtr itemPtr = new IntPtr(pBuf.ToInt64() + (i * structSize));
                    var job = (JOB_INFO_1)Marshal.PtrToStructure(itemPtr, typeof(JOB_INFO_1));
                    if (i > 0) sb.Append(",");
                    sb.AppendFormat("{{\"JobId\":{0},\"Document\":\"{1}\",\"Status\":{2},\"TotalPages\":{3},\"PagesPrinted\":{4}}}",
                        job.JobId, EscapeJson(job.pDocument), job.Status, job.TotalPages, job.PagesPrinted);
                }
                sb.Append("]");
                Console.WriteLine(sb.ToString());
                return 0;
            } finally {
                Marshal.FreeHGlobal(pBuf);
            }
        }

        static int HandleJobStatus(IntPtr hPrinter, int jobId) {
            int needed;
            GetJob(hPrinter, jobId, 1, IntPtr.Zero, 0, out needed);
            int lastErr = Marshal.GetLastWin32Error();

            // If job does not exist in spooler queue:
            // Win32 error 4312 (ERROR_OBJECT_NOT_FOUND) or 87 (ERROR_INVALID_PARAMETER)
            if (needed <= 0) {
                if (lastErr == 4312 || lastErr == 87 || lastErr == 0) {
                    Console.WriteLine("{\"state\":\"COMPLETED_OR_REMOVED\",\"message\":\"Spool job completed and handed off to printer.\"}");
                    return 0;
                }
                Console.WriteLine("{{\"state\":\"UNKNOWN\",\"failureCode\":\"UNKNOWN\",\"message\":\"Failed to query job: error {0}\"}}", lastErr);
                return 0;
            }

            IntPtr pBuf = Marshal.AllocHGlobal(needed);
            try {
                if (!GetJob(hPrinter, jobId, 1, pBuf, needed, out needed)) {
                    int err = Marshal.GetLastWin32Error();
                    if (err == 4312 || err == 87) {
                        Console.WriteLine("{\"state\":\"COMPLETED_OR_REMOVED\",\"message\":\"Spool job completed and handed off to printer.\"}");
                        return 0;
                    }
                    Console.WriteLine("{{\"state\":\"UNKNOWN\",\"failureCode\":\"UNKNOWN\",\"message\":\"GetJob failed: error {0}\"}}", err);
                    return 0;
                }

                var job = (JOB_INFO_1)Marshal.PtrToStructure(pBuf, typeof(JOB_INFO_1));
                uint mask = job.Status;
                string jobStatusStr = (job.pStatus ?? "").ToLowerInvariant();

                if ((mask & (JOB_STATUS_COMPLETE | JOB_STATUS_PRINTED)) != 0 ||
                    (job.TotalPages > 0 && job.PagesPrinted >= job.TotalPages)) {
                    Console.WriteLine("{\"state\":\"COMPLETED_OR_REMOVED\",\"message\":\"Spool job completed and handed off to printer.\"}");
                    return 0;
                }

                if ((mask & JOB_STATUS_PAPEROUT) != 0 || jobStatusStr.Contains("paper")) {
                    Console.WriteLine("{\"state\":\"BLOCKED\",\"failureCode\":\"PAPER_OUT\",\"message\":\"Printer is out of paper.\"}");
                    return 0;
                }

                if ((mask & JOB_STATUS_USER_INTERVENTION) != 0 || jobStatusStr.Contains("intervention")) {
                    Console.WriteLine("{\"state\":\"BLOCKED\",\"failureCode\":\"USER_INTERVENTION\",\"message\":\"User intervention required.\"}");
                    return 0;
                }

                if ((mask & JOB_STATUS_OFFLINE) != 0 || jobStatusStr.Contains("offline")) {
                    Console.WriteLine("{\"state\":\"BLOCKED\",\"failureCode\":\"OFFLINE\",\"message\":\"Printer is offline.\"}");
                    return 0;
                }

                if ((mask & JOB_STATUS_BLOCKED_DEVQ) != 0) {
                    Console.WriteLine("{\"state\":\"BLOCKED\",\"failureCode\":\"PRINTER_ERROR\",\"message\":\"Printer device queue is blocked.\"}");
                    return 0;
                }

                if ((mask & JOB_STATUS_ERROR) != 0 || jobStatusStr.Contains("error")) {
                    Console.WriteLine("{\"state\":\"FAILED\",\"failureCode\":\"PRINTER_ERROR\",\"message\":\"Spooler error occurred.\"}");
                    return 0;
                }

                if ((mask & JOB_STATUS_SPOOLING) != 0 || jobStatusStr.Contains("spool")) {
                    Console.WriteLine("{\"state\":\"SPOOLING\"}");
                    return 0;
                }

                if ((mask & JOB_STATUS_PRINTING) != 0 || jobStatusStr.Contains("print")) {
                    Console.WriteLine("{\"state\":\"PRINTING\"}");
                    return 0;
                }

                Console.WriteLine("{\"state\":\"QUEUED\"}");
                return 0;
            } finally {
                Marshal.FreeHGlobal(pBuf);
            }
        }
    }
}

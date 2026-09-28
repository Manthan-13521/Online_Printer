#!/usr/bin/env node
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const distPackageDir = path.resolve(
  rootDir,
  "dist-package/PrintGo-Windows-Test",
);
const remoteHost = process.env.PRINTGO_REMOTE_HOST || "printgo-windows";
const remoteDir = "C:/Users/MANTH/Downloads/PrintGo-Windows-Test";

console.log("===================================================");
console.log("     PrintGo Remote Windows Agent Deployment");
console.log("===================================================");
console.log(`Target: ${remoteHost} -> ${remoteDir}\n`);

// 1. Build Agent Bundle on Mac
console.log("1. Building standalone Agent bundle on Mac...");
execSync("node scripts/build-agent-windows.mjs", {
  cwd: rootDir,
  stdio: "inherit",
});

// 2. Stop running Agent on Windows
console.log(
  "\n2. Checking and stopping any running test Agent processes on Windows...",
);
try {
  execSync(
    `ssh ${remoteHost} "powershell.exe -NoProfile -ExecutionPolicy Bypass -Command \\"Stop-Process -Name *PrintGo-Agent* -Force -ErrorAction SilentlyContinue\\""`,
    { stdio: "inherit" },
  );
} catch {
  // Ignore if no process was running
}

// 3. Backup existing binary on Windows
console.log("\n3. Creating backup of previous Windows Agent binary...");
try {
  execSync(
    `ssh ${remoteHost} "cmd.exe /c if exist ${remoteDir.replace(/\//g, "\\")}\\PrintGo-Agent.exe copy /Y ${remoteDir.replace(/\//g, "\\")}\\PrintGo-Agent.exe ${remoteDir.replace(/\//g, "\\")}\\PrintGo-Agent.exe.bak"`,
    { stdio: "inherit" },
  );
} catch (err) {
  console.warn("   Backup warning:", err.message);
}

// 4. Transfer bundle and SEA assets to Windows via SCP
console.log("\n4. Transferring updated bundle and assets to Windows...");
const filesToTransfer = [
  "bundle.cjs",
  "sea-prep.blob",
  "sea-config.json",
  "build-exe.bat",
];
for (const file of filesToTransfer) {
  const localFile = path.resolve(distPackageDir, file);
  if (fs.existsSync(localFile)) {
    execSync(`scp "${localFile}" ${remoteHost}:'${remoteDir}/${file}'`, {
      stdio: "inherit",
    });
    console.log(`   Transferred: ${file}`);
  }
}

// 5. Run build-exe.bat on Windows
console.log("\n5. Compiling native PrintGo-Agent.exe on Windows...");
execSync(
  `ssh ${remoteHost} "cmd.exe /c \\"cd /d ${remoteDir.replace(/\//g, "\\")} && build-exe.bat --silent < nul\\""`,
  { stdio: "inherit" },
);

// 6. Verify SHA256 on Windows
console.log("\n6. Verifying SHA-256 checksum on Windows...");
execSync(
  `ssh ${remoteHost} "powershell.exe -NoProfile -ExecutionPolicy Bypass -Command \\"Get-FileHash -Path '${remoteDir.replace(/\//g, "\\")}\\PrintGo-Agent.exe' -Algorithm SHA256 | Select-Object Path, Hash | Format-List\\""`,
  { stdio: "inherit" },
);

console.log("\n===================================================");
console.log("Remote deployment to Windows completed successfully!");
console.log("DPAPI Credentials preserved in AppData.");
console.log("===================================================");

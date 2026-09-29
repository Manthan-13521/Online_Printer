// Developer preflight only: never installs, launches the daemon, pairs or prints.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2).filter((a) => a !== "--");
let build = false,
  seconds = 10;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--build") build = true;
  else if (args[i] === "--observe-seconds") seconds = Number(args[++i]);
  else throw new Error("Unknown option. Use --build or --observe-seconds N.");
}
if (!Number.isInteger(seconds) || seconds < 1 || seconds > 86400)
  throw new Error("Observation must be 1–86400 seconds.");
for (const file of [
  "installer/PrintGo.iss",
  "apps/agent/windows/control-center/PrintGoControlCenter.cs",
  "scripts/windows-hardware-acceptance.ps1",
]) {
  if (!existsSync(path.join(root, file)))
    throw new Error(`Missing source: ${file}`);
}
if (process.platform !== "win32") {
  console.log(
    "Source inventory present. PHYSICAL/WINDOWS VERIFICATION: PENDING. No Windows host was contacted.",
  );
  process.exitCode = 2;
} else {
  function run(command, argv) {
    const result = spawnSync(command, argv, { cwd: root, stdio: "inherit" });
    if (result.error || result.status !== 0)
      throw new Error(
        "Windows verification step failed; inspect the preceding result.",
      );
  }
  if (build) {
    run(process.execPath, [path.join(root, "scripts/build-agent-windows.mjs")]);
    run(process.execPath, [path.join(root, "scripts/package-installer.mjs")]);
  }
  run("powershell.exe", [
    "-NoProfile",
    "-File",
    path.join(root, "scripts/windows-hardware-acceptance.ps1"),
    "-ObserveSeconds",
    String(seconds),
  ]);
}

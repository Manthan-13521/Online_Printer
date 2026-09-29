#!/usr/bin/env node
// Developer build only. Never manufactures executable placeholders or a release URL.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "win32")
  throw new Error(
    "Windows installer compilation is NOT VERIFIED on this host. Run pnpm windows:verify --build on Windows.",
  );
const stage = path.join(root, "installer", "stage"),
  out = path.join(root, "installer", "dist");
fs.mkdirSync(stage, { recursive: true });
fs.mkdirSync(out, { recursive: true });
function run(command, args) {
  const r = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (r.error || r.status !== 0)
    throw new Error(`Build command failed: ${command}`);
}
function pe(file) {
  const b = fs.readFileSync(file);
  if (b.length < 256 || b.toString("ascii", 0, 2) !== "MZ")
    throw new Error(
      `Missing/invalid Windows executable: ${path.basename(file)}`,
    );
  const offset = b.readUInt32LE(0x3c);
  if (offset + 4 > b.length || b.readUInt32LE(offset) !== 0x4550)
    throw new Error("Invalid PE header");
  return b;
}
const agent = path.join(root, "apps/agent/windows/dist/PrintGo-Agent.exe");
pe(agent);
const sumatra =
  process.env.PRINTGO_SUMATRA_PATH ||
  path.join(root, "apps/agent/windows/vendor/SumatraPDF.exe");
const sumatraBytes = pe(sumatra),
  expected = process.env.PRINTGO_SUMATRA_SHA256;
if (
  !expected ||
  !/^[a-f0-9]{64}$/i.test(expected) ||
  createHash("sha256").update(sumatraBytes).digest("hex") !==
    expected.toLowerCase()
)
  throw new Error(
    "Provide the independently verified PRINTGO_SUMATRA_SHA256 for the approved portable binary.",
  );
for (const [source, name] of [
  [agent, "PrintGo-Agent.exe"],
  [sumatra, "SumatraPDF.exe"],
  [path.join(root, "THIRD_PARTY_NOTICES.txt"), "THIRD_PARTY_NOTICES.txt"],
])
  fs.copyFileSync(source, path.join(stage, name));
const csc = path.join(
  process.env.WINDIR || "C:\\Windows",
  "Microsoft.NET/Framework64/v4.0.30319/csc.exe",
);
run(csc, [
  "/target:winexe",
  `/out:${path.join(stage, "PrintGo-ControlCenter.exe")}`,
  path.join(root, "apps/agent/windows/control-center/PrintGoControlCenter.cs"),
  "/r:System.Windows.Forms.dll,System.Drawing.dll,Microsoft.VisualBasic.dll,System.Web.Extensions.dll",
  "/optimize+",
]);
pe(path.join(stage, "PrintGo-ControlCenter.exe"));
const iscc =
  process.env.PRINTGO_ISCC ||
  path.join(
    process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
    "Inno Setup 6/ISCC.exe",
  );
fs.rmSync(path.join(out, "PrintGo-Setup.exe"), { force: true });
fs.rmSync(path.join(out, "build-manifest.json"), { force: true });
run(iscc, [path.join(root, "installer/PrintGo.iss")]);
const files = {};
for (const name of [
  "PrintGo-Agent.exe",
  "PrintGo-ControlCenter.exe",
  "SumatraPDF.exe",
  "PrintGo-Setup.exe",
]) {
  const file = path.join(name === "PrintGo-Setup.exe" ? out : stage, name);
  const bytes = pe(file);
  files[name] = {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  };
}
fs.writeFileSync(
  path.join(out, "build-manifest.json"),
  JSON.stringify(
    {
      version: "2.1.0",
      builtAt: new Date().toISOString(),
      files,
      authenticode: "NOT VERIFIED: inspect with windows:verify",
      licenseReview: "BLOCKED pending approved notices/source obligations",
      releasePublished: false,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  "Local installer built. No installation, signing, publication or release readiness is implied.",
);

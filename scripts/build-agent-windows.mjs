#!/usr/bin/env node
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const agentDir = path.resolve(rootDir, "apps/agent/windows");
const distDir = path.resolve(agentDir, "dist");

console.log("[Build Agent] Ensuring dist directory...");
fs.mkdirSync(distDir, { recursive: true });

console.log("[Build Agent] Bundling Windows Agent with esbuild...");
let esbuild;
try {
  esbuild = await import("esbuild");
} catch {
  const esbuildPath = path.resolve(
    agentDir,
    "node_modules/esbuild/lib/main.js",
  );
  const { pathToFileURL } = await import("node:url");
  esbuild = await import(pathToFileURL(esbuildPath).href);
}

const bundlePath = path.resolve(distDir, "bundle.cjs");

await esbuild.build({
  entryPoints: [path.resolve(agentDir, "src/index.ts")],
  outfile: bundlePath,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  sourcemap: false,
  treeShaking: true,
  define: {
    "import.meta.url": "undefined",
  },
  banner: {
    js: `// PrintGo Windows Agent Standalone Bundle - Generated ${new Date().toISOString()}`,
  },
});

console.log(`[Build Agent] Successfully created bundle at: ${bundlePath}`);

// Write sea-config.json
const seaConfigPath = path.resolve(agentDir, "sea-config.json");
const seaConfig = {
  main: "dist/bundle.cjs",
  output: "dist/sea-prep.blob",
  disableExperimentalSEAWarning: true,
};
fs.writeFileSync(
  seaConfigPath,
  JSON.stringify(seaConfig, null, 2) + "\n",
  "utf8",
);
console.log(`[Build Agent] Created SEA config at: ${seaConfigPath}`);

// Generate sea-prep.blob
console.log("[Build Agent] Generating SEA preparation blob...");
try {
  execSync(`node --experimental-sea-config sea-config.json`, {
    cwd: agentDir,
    stdio: "inherit",
  });
  console.log(`[Build Agent] Generated dist/sea-prep.blob`);
} catch (err) {
  console.warn(`[Build Agent] Could not generate sea-prep.blob:`, err.message);
}

// If on Windows, inject blob into node.exe to produce PrintGo-Agent.exe
const exePath = path.resolve(distDir, "PrintGo-Agent.exe");
if (process.platform === "win32") {
  console.log(
    "[Build Agent] Windows platform detected. Creating PrintGo-Agent.exe...",
  );
  fs.copyFileSync(process.execPath, exePath);

  console.log("[Build Agent] Injecting SEA blob using postject...");
  execSync(
    `npx --yes postject "${exePath}" NODE_SEA_BLOB "${path.resolve(distDir, "sea-prep.blob")}" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`,
    { stdio: "inherit" },
  );
  console.log(`[Build Agent] Successfully created ${exePath}`);
} else {
  console.log(`[Build Agent] Host OS is ${process.platform} (non-Windows).`);
  console.log(
    `[Build Agent] Standalone bundle (bundle.cjs) and sea-prep.blob created.`,
  );
  console.log(
    `[Build Agent] Native Windows .exe will be compiled on Windows or via GitHub Actions workflow.`,
  );
}

// Stage distribution package
const packageDir = path.resolve(rootDir, "dist-package/PrintGo-Windows-Test");
console.log(`[Build Agent] Staging test package to: ${packageDir}`);
fs.mkdirSync(packageDir, { recursive: true });

fs.copyFileSync(bundlePath, path.resolve(packageDir, "bundle.cjs"));
if (fs.existsSync(path.resolve(distDir, "sea-prep.blob"))) {
  fs.copyFileSync(
    path.resolve(distDir, "sea-prep.blob"),
    path.resolve(packageDir, "sea-prep.blob"),
  );
}
fs.copyFileSync(seaConfigPath, path.resolve(packageDir, "sea-config.json"));

if (fs.existsSync(exePath)) {
  fs.copyFileSync(exePath, path.resolve(packageDir, "PrintGo-Agent.exe"));
}

const testScriptsDir = path.resolve(rootDir, "scripts/windows-agent-test");
if (fs.existsSync(testScriptsDir)) {
  for (const file of fs.readdirSync(testScriptsDir)) {
    fs.copyFileSync(
      path.resolve(testScriptsDir, file),
      path.resolve(packageDir, file),
    );
  }
}
console.log(
  "[Build Agent] Staging complete. Files ready in dist-package/PrintGo-Windows-Test.",
);

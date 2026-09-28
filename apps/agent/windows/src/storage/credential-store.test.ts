import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DevelopmentCredentialStore,
  type AgentCredentials,
} from "./credential-store";

describe("DevelopmentCredentialStore", () => {
  let tempDir: string;
  let testFile: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "printgo-cred-test-"));
    testFile = path.join(tempDir, "creds.json");
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("returns null when no credentials file exists", async () => {
    const store = new DevelopmentCredentialStore(testFile);
    await expect(store.load()).resolves.toBeNull();
  });

  it("saves and loads agent credentials", async () => {
    const store = new DevelopmentCredentialStore(testFile);
    const creds: AgentCredentials = {
      agentId: "agent_42",
      agentSecret: "super_secret_token_123456789012345",
      serverUrl: "https://api.printgo.shop",
      displayName: "Front Desk PC",
    };

    await store.save(creds);
    const loaded = await store.load();
    expect(loaded).toEqual(creds);
  });

  it("clears saved credentials", async () => {
    const store = new DevelopmentCredentialStore(testFile);
    const creds: AgentCredentials = {
      agentId: "agent_42",
      agentSecret: "super_secret_token_123456789012345",
      serverUrl: "https://api.printgo.shop",
      displayName: "Front Desk PC",
    };

    await store.save(creds);
    expect(await store.load()).not.toBeNull();

    await store.clear();
    expect(await store.load()).toBeNull();
  });

  it("rejects malformed or incomplete credential files", async () => {
    await fs.writeFile(
      testFile,
      JSON.stringify({ agentId: "agent_42", agentSecret: "short" }),
    );
    const store = new DevelopmentCredentialStore(testFile);

    await expect(store.load()).rejects.toThrow(/invalid or incomplete/i);
  });

  it("passes readiness verification immediately", async () => {
    const store = new DevelopmentCredentialStore(testFile);
    await expect(store.verifyReadiness()).resolves.toBeUndefined();
  });
});

import {
  WindowsDpapiCredentialStore,
  type PowerShellExecutor,
} from "./credential-store";

describe("WindowsDpapiCredentialStore", () => {
  let tempDir: string;
  let testFile: string;

  const sampleCredentials: AgentCredentials = {
    agentId: "agent_win_12345",
    agentSecret: "ultra_secure_dpapi_token_678901234567890",
    serverUrl: "https://api.printgo.shop",
    displayName: "Counter Thermal Printer PC",
  };

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "printgo-dpapi-test-"));
    testFile = path.join(tempDir, "agent-credentials.dat");
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  // Simulated DPAPI mock executor for cross-platform deterministic unit tests
  function createMockDpapiExecutor(): {
    executor: PowerShellExecutor;
    scriptsExecuted: string[];
  } {
    const scriptsExecuted: string[] = [];
    const executor: PowerShellExecutor = (script, inputData) => {
      scriptsExecuted.push(script);

      // Verify that the script explicitly loads System.Security
      expect(script).toContain("Add-Type -AssemblyName 'System.Security'");
      expect(script).toContain("System.Security.Cryptography.ProtectedData");

      if (script.includes("ProtectedData]::Protect")) {
        // Mock DPAPI encryption: XOR transform + base64 prefix
        const plainBytes = Buffer.from(inputData, "base64");
        const cipherBytes = Buffer.from(plainBytes.map((b) => b ^ 0x5a));
        return Promise.resolve(cipherBytes.toString("base64"));
      }

      if (script.includes("ProtectedData]::Unprotect")) {
        // Mock DPAPI decryption: XOR reverse + base64 output
        const cipherBytes = Buffer.from(inputData, "base64");
        const plainBytes = Buffer.from(cipherBytes.map((b) => b ^ 0x5a));
        return Promise.resolve(plainBytes.toString("base64"));
      }

      return Promise.reject(
        new Error(`Unexpected script in mock DPAPI executor: ${script}`),
      );
    };
    return { executor, scriptsExecuted };
  }

  it("encryption success: encrypts credentials and formats script with assembly loading", async () => {
    const { executor, scriptsExecuted } = createMockDpapiExecutor();
    const store = new WindowsDpapiCredentialStore(testFile, executor);

    await store.save(sampleCredentials);

    expect(scriptsExecuted.length).toBe(1);
    expect(scriptsExecuted[0]).toContain(
      "Add-Type -AssemblyName 'System.Security'",
    );
    expect(scriptsExecuted[0]).toContain(
      "System.Security.Cryptography.ProtectedData",
    );
    expect(scriptsExecuted[0]).toContain("DataProtectionScope]::CurrentUser");

    // File was created
    const fileExists = await fs
      .stat(testFile)
      .then(() => true)
      .catch(() => false);
    expect(fileExists).toBe(true);
  });

  it("decryption success: unprotects stored ciphertext into valid AgentCredentials", async () => {
    const { executor } = createMockDpapiExecutor();
    const store = new WindowsDpapiCredentialStore(testFile, executor);

    await store.save(sampleCredentials);
    const loaded = await store.load();

    expect(loaded).toEqual(sampleCredentials);
  });

  it("round trip: verifyReadiness self-test probe encrypts and decrypts cleanly", async () => {
    const { executor } = createMockDpapiExecutor();
    const store = new WindowsDpapiCredentialStore(testFile, executor);

    await expect(store.verifyReadiness()).resolves.toBeUndefined();
  });

  it("corrupted encrypted data: fails closed when ciphertext is corrupted", async () => {
    const mockExecutor: PowerShellExecutor = (script) => {
      if (script.includes("ProtectedData]::Unprotect")) {
        return Promise.reject(
          new Error(
            "Windows DPAPI PowerShell error: Command failed (diagnostic: DPAPI_UNPROTECT_FAILED: The data is invalid.)",
          ),
        );
      }
      return Promise.resolve("dummy");
    };

    await fs.writeFile(testFile, "corrupted_non_dpapi_data_==", "utf8");
    const store = new WindowsDpapiCredentialStore(testFile, mockExecutor);

    await expect(store.load()).rejects.toThrow(
      /Failed to load DPAPI credentials/i,
    );
    await expect(store.load()).rejects.toThrow(/DPAPI_UNPROTECT_FAILED/i);
  });

  it("missing/unavailable DPAPI dependency: fails closed with diagnostic message without leaking secrets", async () => {
    const missingDependencyExecutor: PowerShellExecutor = () =>
      Promise.reject(
        new Error(
          "Windows DPAPI PowerShell error: Command failed (diagnostic: DPAPI_UNAVAILABLE: System.Security.Cryptography.ProtectedData could not be loaded into PowerShell AppDomain.)",
        ),
      );

    const store = new WindowsDpapiCredentialStore(
      testFile,
      missingDependencyExecutor,
    );

    await expect(store.verifyReadiness()).rejects.toThrow(
      /Windows DPAPI credential encryption is unavailable on this machine/i,
    );
    await expect(store.verifyReadiness()).rejects.toThrow(/DPAPI_UNAVAILABLE/i);
  });

  it("credentials never written as plaintext: raw file on disk contains only encrypted ciphertext", async () => {
    const { executor } = createMockDpapiExecutor();
    const store = new WindowsDpapiCredentialStore(testFile, executor);

    await store.save(sampleCredentials);

    const rawFileContent = await fs.readFile(testFile, "utf8");

    // The secret token must NEVER exist in plaintext on disk
    expect(rawFileContent).not.toContain(sampleCredentials.agentSecret);
    expect(rawFileContent).not.toContain(sampleCredentials.agentId);
    expect(rawFileContent).not.toContain(sampleCredentials.displayName);
    expect(rawFileContent).not.toContain(sampleCredentials.serverUrl);
    expect(rawFileContent).not.toContain("{");
    expect(rawFileContent).not.toContain("}");

    // File content must be valid base64
    expect(rawFileContent.trim()).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it("returns null when no credential file exists", async () => {
    const { executor } = createMockDpapiExecutor();
    const store = new WindowsDpapiCredentialStore(testFile, executor);

    await expect(store.load()).resolves.toBeNull();
  });

  it("clears credentials file", async () => {
    const { executor } = createMockDpapiExecutor();
    const store = new WindowsDpapiCredentialStore(testFile, executor);

    await store.save(sampleCredentials);
    await store.clear();

    await expect(store.load()).resolves.toBeNull();
  });

  // Native Windows Integration Test: runs ONLY on real Windows runners (win32)
  it.runIf(process.platform === "win32")(
    "real Windows OS DPAPI integration: encrypts, decrypts, and persists using native powershell.exe",
    async () => {
      const store = new WindowsDpapiCredentialStore(testFile);

      // Verify native readiness preflight
      await expect(store.verifyReadiness()).resolves.toBeUndefined();

      // Verify native save and load
      await store.save(sampleCredentials);
      const loaded = await store.load();
      expect(loaded).toEqual(sampleCredentials);

      // Verify physical file is encrypted
      const fileBytes = await fs.readFile(testFile, "utf8");
      expect(fileBytes).not.toContain(sampleCredentials.agentSecret);
      expect(fileBytes).toMatch(/^[A-Za-z0-9+/=\s]+$/);
    },
  );
});

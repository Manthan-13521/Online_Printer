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
      agentSecret: "super_secret_token_12345",
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
      agentSecret: "super_secret_token_12345",
      serverUrl: "https://api.printgo.shop",
      displayName: "Front Desk PC",
    };

    await store.save(creds);
    expect(await store.load()).not.toBeNull();

    await store.clear();
    expect(await store.load()).toBeNull();
  });
});

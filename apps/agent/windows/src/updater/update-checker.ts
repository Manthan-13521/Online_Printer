import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";

export interface ReleaseManifest {
  version: string;
  releaseDate: string;
  downloadUrl: string;
  fileName: string;
  sha256: string;
  fileSizeBytes: number;
  minSupportedVersion?: string;
  changelog?: string[];
}

export interface UpdateCheckResult {
  updateAvailable: boolean;
  isCritical: boolean;
  currentVersion: string;
  latestVersion: string;
  downloadUrl?: string | undefined;
  sha256?: string | undefined;
  changelog?: string[] | undefined;
}

export function compareSemver(v1: string, v2: string): number {
  const parse = (v: string) =>
    v
      .replace(/^v/i, "")
      .split(".")
      .map((part) => parseInt(part, 10) || 0);

  const [maj1 = 0, min1 = 0, pat1 = 0] = parse(v1);
  const [maj2 = 0, min2 = 0, pat2 = 0] = parse(v2);

  if (maj1 !== maj2) return maj1 - maj2;
  if (min1 !== min2) return min1 - min2;
  return pat1 - pat2;
}

export async function checkReleaseUpdate(
  currentVersion: string,
  fetchManifest: () => Promise<ReleaseManifest>,
): Promise<UpdateCheckResult> {
  const manifest = await fetchManifest();

  let downloadUrl: URL;
  try {
    downloadUrl = new URL(manifest.downloadUrl);
  } catch {
    throw new Error("Insecure download URL rejected.");
  }
  if (
    downloadUrl.protocol !== "https:" ||
    downloadUrl.username ||
    downloadUrl.password
  ) {
    throw new Error("Insecure download URL rejected.");
  }
  if (!/^[a-fA-F0-9]{64}$/.test(manifest.sha256 ?? "")) {
    throw new Error("Invalid SHA-256 checksum format in release manifest.");
  }
  if (
    ![
      currentVersion,
      manifest.version,
      ...(manifest.minSupportedVersion ? [manifest.minSupportedVersion] : []),
    ].every((v) => /^v?\d+\.\d+\.\d+$/.test(v)) ||
    !Number.isSafeInteger(manifest.fileSizeBytes) ||
    manifest.fileSizeBytes <= 0
  ) {
    throw new Error("Invalid release version or size.");
  }

  const diff = compareSemver(manifest.version, currentVersion);
  const updateAvailable = diff > 0;

  let isCritical = false;
  if (manifest.minSupportedVersion) {
    isCritical =
      compareSemver(manifest.minSupportedVersion, currentVersion) > 0;
  }

  const result: UpdateCheckResult = {
    updateAvailable,
    isCritical,
    currentVersion,
    latestVersion: manifest.version,
  };

  if (updateAvailable) {
    result.downloadUrl = manifest.downloadUrl;
    result.sha256 = manifest.sha256;
  }
  if (manifest.changelog) {
    result.changelog = manifest.changelog;
  }

  return result;
}

export async function verifyFileChecksum(
  filePath: string,
  expectedSha256: string,
): Promise<boolean> {
  try {
    const data = await fs.readFile(filePath);
    const hash = crypto.createHash("sha256").update(data).digest("hex");
    return hash.toLowerCase() === expectedSha256.toLowerCase();
  } catch {
    return false;
  }
}

export async function verifyInstallerForExecution(
  filePath: string,
  expectedSha256: string,
): Promise<{ valid: boolean; reason?: string }> {
  try {
    const stat = await fs.stat(filePath);
    if (stat.size === 0) {
      return { valid: false, reason: "Installer file is empty (0 bytes)." };
    }
    const matches = await verifyFileChecksum(filePath, expectedSha256);
    if (!matches) {
      return {
        valid: false,
        reason:
          "SHA-256 checksum mismatch. Installer integrity cannot be verified.",
      };
    }
    return { valid: true };
  } catch (err) {
    return {
      valid: false,
      reason: `Failed to inspect installer: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

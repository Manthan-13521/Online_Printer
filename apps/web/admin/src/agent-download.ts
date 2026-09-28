/**
 * Centralized configuration for the Windows Print Agent binary download.
 *
 * In production, this can point to a GitHub Releases asset, an R2 bucket release URL,
 * or dedicated binary hosting URL (configured via import.meta.env.VITE_WINDOWS_AGENT_DOWNLOAD_URL).
 *
 * When no release URL is configured, the UI safely reports the artifact status as
 * "BUILD_PENDING", allowing the shop owner to see the setup steps without a broken or fabricated link.
 */

export const DEFAULT_WINDOWS_AGENT_DOWNLOAD_URL =
  "https://github.com/Manthan-13521/Online_Printer/releases/download/v2.0.0/PrintGo-Agent.exe";
export const DEFAULT_WINDOWS_AGENT_ZIP_DOWNLOAD_URL =
  "https://github.com/Manthan-13521/Online_Printer/releases/download/v2.0.0/PrintGo-Windows-Test.zip";
export const DEFAULT_WINDOWS_AGENT_SHA256 =
  "8554ed069448c4c953e90620ad962105394fa71a76eb94688f0e11cef07db91a";

export interface WindowsAgentReleaseConfig {
  /** Download URL for the precompiled Windows executable or installer */
  downloadUrl: string | null;
  /** Suggested filename for the user download */
  fileName: string;
  /** Version or release tag */
  version: string;
  /** Whether the download artifact is currently live and available */
  isLive: boolean;
  /** Human-readable status note */
  statusNote: string;
  /** SHA-256 Checksum */
  sha256?: string;
  /** Optional zip bundle download URL */
  zipDownloadUrl?: string;
}

export function getWindowsAgentReleaseConfig(): WindowsAgentReleaseConfig {
  const envUrl = (
    import.meta.env.VITE_WINDOWS_AGENT_DOWNLOAD_URL as string | undefined
  )?.trim();

  // If a production URL is explicitly configured in env, mark as live
  if (
    envUrl &&
    (envUrl.startsWith("https://") || envUrl.startsWith("http://"))
  ) {
    return {
      downloadUrl: envUrl,
      fileName: "PrintGo-Agent.exe",
      version: "v2.0.0",
      isLive: true,
      statusNote: "Ready to download",
      sha256: DEFAULT_WINDOWS_AGENT_SHA256,
      zipDownloadUrl: DEFAULT_WINDOWS_AGENT_ZIP_DOWNLOAD_URL,
    };
  }

  // In production builds, default to the verified live GitHub Releases v2.0.0 URL
  if (import.meta.env.PROD) {
    return {
      downloadUrl: DEFAULT_WINDOWS_AGENT_DOWNLOAD_URL,
      fileName: "PrintGo-Agent.exe",
      version: "v2.0.0",
      isLive: true,
      statusNote: "Ready to download (Verified v2.0.0 Release)",
      sha256: DEFAULT_WINDOWS_AGENT_SHA256,
      zipDownloadUrl: DEFAULT_WINDOWS_AGENT_ZIP_DOWNLOAD_URL,
    };
  }

  return {
    downloadUrl: null,
    fileName: "PrintGo-Agent.exe",
    version: "v2.0.0",
    isLive: false,
    statusNote:
      "Precompiled Windows binary hosting not configured. Packaged via GitHub Actions or locally with 'pnpm build:agent:windows'.",
    sha256: DEFAULT_WINDOWS_AGENT_SHA256,
  };
}

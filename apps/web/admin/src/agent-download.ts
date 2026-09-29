/**
 * Centralized configuration for the Windows Print Agent binary download.
 *
 * In production, this can point to a GitHub Releases asset, an R2 bucket release URL,
 * or dedicated binary hosting URL (configured via import.meta.env.VITE_WINDOWS_AGENT_DOWNLOAD_URL).
 *
 * When no release URL is configured, the UI safely reports the artifact status as
 * "BUILD_PENDING", allowing the shop owner to see the setup steps without a broken or fabricated link.
 */

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

  const hash = String(import.meta.env.VITE_WINDOWS_AGENT_SHA256 ?? "").trim();
  const version = String(
    import.meta.env.VITE_WINDOWS_AGENT_VERSION ?? "",
  ).trim();
  let validUrl = false;
  try {
    const url = new URL(envUrl ?? "");
    validUrl = url.protocol === "https:" && !url.username && !url.password;
  } catch {
    /* Missing or invalid configuration stays unavailable. */
  }
  if (
    envUrl &&
    validUrl &&
    /^[a-f0-9]{64}$/i.test(hash) &&
    /^v?\d+\.\d+\.\d+$/.test(version)
  ) {
    return {
      downloadUrl: envUrl,
      fileName: "PrintGo-Setup.exe",
      version,
      isLive: true,
      statusNote: "Installer provided by your shop technician",
      sha256: hash,
    };
  }
  return {
    downloadUrl: null,
    fileName: "PrintGo-Setup.exe",
    version: "Pending",
    isLive: false,
    statusNote:
      "Your shop technician has not yet provided the approved Windows installer.",
  };
}

export function buildAgentConnectionUrl(
  code: string,
  serverUrl: string,
): string | null {
  try {
    const server = new URL(serverUrl);
    if (
      server.protocol !== "https:" ||
      server.username ||
      server.password ||
      server.pathname !== "/" ||
      server.search ||
      server.hash
    )
      return null;
    return (
      "printgo://connect?server=" +
      encodeURIComponent(server.origin) +
      "&code=" +
      encodeURIComponent(code)
    );
  } catch {
    return null;
  }
}

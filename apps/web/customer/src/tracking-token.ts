const TRACKING_TOKEN_BYTES = 32;

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export function createTrackingToken(): string {
  return encodeBase64Url(
    crypto.getRandomValues(new Uint8Array(TRACKING_TOKEN_BYTES)),
  );
}

export function trackingStorageKey(jobCode: string): string {
  return `printgo.tracking.${jobCode}`;
}

export function privateTrackingUrl(jobCode: string, token: string): string {
  return `${window.location.origin}/track/${encodeURIComponent(jobCode)}#${token}`;
}

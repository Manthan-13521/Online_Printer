/**
 * Consolidated formatting utilities for PrintGo Admin.
 * Pure, deterministic functions with zero side-effects.
 */

/** Formats integer paise into a human-readable rupee string (e.g. 2100 -> ₹21.00). */
export function formatPaise(paise: number): string {
  return `₹${(paise / 100).toFixed(2)}`;
}

/** Formats an ISO date string into a user-friendly relative timestamp. */
export function formatRelativeTime(dateString: string | null): string {
  if (!dateString) return "Never";
  const date = new Date(dateString);
  const now = new Date();
  const diffSeconds = Math.round((now.getTime() - date.getTime()) / 1000);

  if (diffSeconds < 5) return "Just now";
  if (diffSeconds < 60) return `${diffSeconds}s ago`;
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return date.toLocaleDateString();
}

/** Formats an ISO date string into a localized date-time string. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

/** Formats an ISO date string into a localized time-only string (e.g. 8:35:03 PM). */
export function formatTimeOnly(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString();
}

/** Extracts up to 2 uppercase initial letters from a customer's name. */
export function getInitials(name?: string | null): string {
  if (!name || !name.trim()) return "C";
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

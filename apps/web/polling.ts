/** One request at a time, no hidden-tab traffic, immediate focus refresh. */
export function startVisiblePolling(
  poll: () => Promise<boolean | void>,
  intervalMs: number,
  maximumMs = 60_000,
): () => void {
  let stopped = false;
  let busy = false;
  let unchanged = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function tick() {
    clearTimeout(timer);
    if (stopped || busy || document.hidden) return;
    busy = true;
    try {
      const changed = await poll();
      unchanged = changed === false ? unchanged + 1 : 0;
    } finally {
      busy = false;
      if (!stopped && !document.hidden) {
        timer = setTimeout(
          () => void tick(),
          Math.min(maximumMs, intervalMs * (unchanged >= 3 ? 2 : 1)),
        );
      }
    }
  }
  function visibility() {
    clearTimeout(timer);
    unchanged = 0;
    if (!document.hidden) void tick();
  }
  document.addEventListener("visibilitychange", visibility);
  void tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
    document.removeEventListener("visibilitychange", visibility);
  };
}

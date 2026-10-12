// @vitest-environment jsdom

import { renderHook, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAdminWebSocket } from "./useAdminWebSocket";

describe("useAdminWebSocket", () => {
  let mockWsInstance: {
    send: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    onmessage: ((event: { data: string }) => void) | null;
    onerror: (() => void) | null;
    onclose: (() => void) | null;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    mockWsInstance = {
      send: vi.fn(),
      close: vi.fn(),
      onmessage: null,
      onerror: null,
      onclose: null,
    };
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = vi.fn(
      () => mockWsInstance,
    );
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("connects to WebSocket and triggers onWakeUp when receiving WAKE_UP event", () => {
    const onWakeUp = vi.fn();
    renderHook(() => useAdminWebSocket(onWakeUp));

    expect(globalThis.WebSocket).toHaveBeenCalledTimes(1);
    expect(mockWsInstance.onmessage).toBeDefined();

    // Receiving non-WAKE_UP event does not trigger callback
    act(() => {
      mockWsInstance.onmessage?.({ data: JSON.stringify({ type: "OTHER" }) });
    });
    expect(onWakeUp).not.toHaveBeenCalled();

    // Receiving WAKE_UP triggers onWakeUp
    act(() => {
      mockWsInstance.onmessage?.({ data: JSON.stringify({ type: "WAKE_UP" }) });
    });
    expect(onWakeUp).toHaveBeenCalledTimes(1);
  });

  it("reconnects after socket closes", () => {
    const onWakeUp = vi.fn();
    renderHook(() => useAdminWebSocket(onWakeUp));

    expect(globalThis.WebSocket).toHaveBeenCalledTimes(1);

    // Trigger close
    act(() => {
      mockWsInstance.onclose?.();
    });

    // Advance 15s backoff
    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    expect(globalThis.WebSocket).toHaveBeenCalledTimes(2);
  });

  it("cleans up connection and timers on unmount", () => {
    const onWakeUp = vi.fn();
    const { unmount } = renderHook(() => useAdminWebSocket(onWakeUp));

    unmount();
    expect(mockWsInstance.close).toHaveBeenCalledTimes(1);
  });
});

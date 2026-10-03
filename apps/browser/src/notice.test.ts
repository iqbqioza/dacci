import { afterEach, describe, expect, it, vi } from "vitest";
import { clearNotice, noticeMessage, showNotice } from "./notice.js";

afterEach(() => {
  clearNotice();
  vi.useRealTimers();
});

describe("showNotice", () => {
  it("shows the message until told otherwise", () => {
    vi.useFakeTimers();
    showNotice("saved");
    expect(noticeMessage()).toBe("saved");
    clearNotice();
    expect(noticeMessage()).toBeNull();
  });

  it("clears itself after the duration", async () => {
    vi.useFakeTimers();
    showNotice("saved", 2000);
    expect(noticeMessage()).toBe("saved");
    await vi.advanceTimersByTimeAsync(1999);
    expect(noticeMessage()).toBe("saved");
    await vi.advanceTimersByTimeAsync(1);
    expect(noticeMessage()).toBeNull();
  });

  it("restarts the clock when a second notice replaces the first", async () => {
    vi.useFakeTimers();
    showNotice("first", 2000);
    await vi.advanceTimersByTimeAsync(1500);
    showNotice("second", 2000);
    // The first timer was cleared: at its own deadline nothing happens.
    await vi.advanceTimersByTimeAsync(500);
    expect(noticeMessage()).toBe("second");
    await vi.advanceTimersByTimeAsync(1500);
    expect(noticeMessage()).toBeNull();
  });
});

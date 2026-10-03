import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./clipboard.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("copyText", () => {
  it("uses the clipboard API where the context is secure", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    expect(await copyText("hello")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("falls back to the legacy path over plain http", async () => {
    // No clipboard API outside a secure context, so the legacy textarea path
    // carries it instead of failing silently.
    vi.stubGlobal("navigator", {});
    const selected: string[] = [];
    const area = {
      value: "",
      style: {} as Record<string, string>,
      setAttribute: vi.fn(),
      select: vi.fn(() => {
        selected.push(area.value);
      }),
      remove: vi.fn(),
    };
    vi.stubGlobal("document", {
      createElement: vi.fn(() => area),
      body: { append: vi.fn() },
      execCommand: vi.fn(() => true),
    });
    expect(await copyText("fallback")).toBe(true);
    expect(selected).toEqual(["fallback"]);
  });

  it("reports when even the legacy path fails", async () => {
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("document", {
      createElement: vi.fn(() => ({
        value: "",
        style: {},
        setAttribute: vi.fn(),
        select: vi.fn(),
        remove: vi.fn(),
      })),
      body: { append: vi.fn() },
      execCommand: vi.fn(() => {
        throw new Error("denied");
      }),
    });
    expect(await copyText("x")).toBe(false);
  });
});

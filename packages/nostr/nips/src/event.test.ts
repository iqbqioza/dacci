import { describe, expect, it } from "vitest";
import {
  compareEvents,
  computeEventId,
  hasValidId,
  isValidEventStructure,
  pubkeyFor,
  type NostrEvent,
} from "../src/event.js";

function makeEvent(overrides: Partial<NostrEvent> = {}): NostrEvent {
  const base = {
    pubkey: "a".repeat(64),
    created_at: 1000,
    kind: 1,
    tags: [],
    content: "hello",
  };
  const id = computeEventId({ ...base, ...overrides });
  return { ...base, ...overrides, id, sig: "b".repeat(128) };
}

describe("computeEventId", () => {
  it("is deterministic and 64 lowercase hex chars", () => {
    const event = makeEvent();
    expect(event.id).toMatch(/^[0-9a-f]{64}$/);
    expect(computeEventId(event)).toBe(event.id);
  });

  it("changes when content changes", () => {
    expect(makeEvent({ content: "x" }).id).not.toBe(
      makeEvent({ content: "y" }).id,
    );
  });
});

describe("isValidEventStructure", () => {
  it("accepts a well-formed event", () => {
    expect(isValidEventStructure(makeEvent())).toBe(true);
  });

  it("rejects out-of-range kind and bad id", () => {
    expect(
      isValidEventStructure({ ...makeEvent(), kind: 70000 }),
    ).toBe(false);
    expect(isValidEventStructure({ ...makeEvent(), id: "zz" })).toBe(false);
  });
});

describe("hasValidId", () => {
  it("detects tampering", () => {
    const event = makeEvent();
    expect(hasValidId(event)).toBe(true);
    expect(hasValidId({ ...event, content: "tampered" })).toBe(false);
  });
});

describe("compareEvents", () => {
  it("orders newest first with id ascending tie-break", () => {
    const older = makeEvent({ created_at: 999 });
    const a = makeEvent({ created_at: 1000, content: "a" });
    const b = makeEvent({ created_at: 1000, content: "b" });
    const sorted = [older, b, a].sort(compareEvents);
    expect(sorted[0]).toBe(a.created_at === b.created_at && a.id < b.id ? a : b);
    expect(sorted[sorted.length - 1]).toBe(older);
    const [first, second] = [a, b].sort(compareEvents);
    expect(first.id < second.id).toBe(true);
  });
});

describe("pubkeyFor", () => {
  it("derives the pubkey a secret signs under", () => {
    // Agrees with NsecSigner, which gates the same way.
    expect(pubkeyFor("11".repeat(32))).toHaveLength(64);
  });

  it("refuses anything but 32-byte lowercase hex, like NsecSigner", () => {
    for (const bad of [
      "",
      "zz".repeat(32),
      "11".repeat(31),
      "AA".repeat(32),
      "11".repeat(32) + "11",
    ]) {
      expect(() => pubkeyFor(bad)).toThrow(
        "secret key must be 32-byte lowercase hex",
      );
    }
  });
});

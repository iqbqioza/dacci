import { describe, expect, it } from "vitest";
import { isRelayMessage } from "./message.js";

describe("isRelayMessage", () => {
  it("accepts every relay message shape NIP-01 names", () => {
    const event = {
      id: "a".repeat(64),
      pubkey: "b".repeat(64),
      created_at: 1,
      kind: 1,
      tags: [],
      content: "",
      sig: "s".repeat(128),
    };
    expect(isRelayMessage(["EVENT", "sub", event])).toBe(true);
    expect(isRelayMessage(["OK", "a".repeat(64), true, ""])).toBe(true);
    expect(isRelayMessage(["OK", "a".repeat(64), false, "duplicate: x"])).toBe(
      true,
    );
    expect(isRelayMessage(["EOSE", "sub"])).toBe(true);
    expect(isRelayMessage(["CLOSED", "sub", "auth-required: x"])).toBe(true);
    expect(isRelayMessage(["NOTICE", "hi"])).toBe(true);
    expect(isRelayMessage(["AUTH", "challenge"])).toBe(true);
  });

  it("rejects what is not a message at all", () => {
    expect(isRelayMessage(null)).toBe(false);
    expect(isRelayMessage("EVENT")).toBe(false);
    expect(isRelayMessage([])).toBe(false);
    expect(isRelayMessage(["REQ", "sub"])).toBe(false);
    expect(isRelayMessage(["EVENTX", "sub"])).toBe(false);
  });

  it("rejects a type word with nothing behind it", () => {
    // The predicate is a type guard, so a bare `["EVENT"]` satisfying it hands
    // every direct consumer an `undefined` where the type promises an event.
    // `dispatch` re-checks per branch today, which is why this never bit —
    // the guard must not rely on every caller doing that again.
    //
    // The optional tails stay optional: a `CLOSED` without a reason and an `OK`
    // without a message are messages relays really send.
    expect(isRelayMessage(["EVENT"])).toBe(false);
    expect(isRelayMessage(["OK"])).toBe(false);
    expect(isRelayMessage(["OK", "a".repeat(64)])).toBe(false);
    expect(isRelayMessage(["OK", "a".repeat(64), true])).toBe(true);
    expect(isRelayMessage(["EOSE"])).toBe(false);
    expect(isRelayMessage(["CLOSED", "sub"])).toBe(true);
    expect(isRelayMessage(["NOTICE"])).toBe(false);
    expect(isRelayMessage(["AUTH"])).toBe(false);
  });

  it("accepts a relay's extensions past the mandatory prefix", () => {
    // Observed on the wire: nostrfy answers EOSE as `["EOSE", id, ["more"]]`.
    // Rejecting that at the gate hung every query to it until its timeout —
    // the socket was open, events even arrived, and the status row still said
    // offline. Lengths are minimums; what `dispatch` ignores is not this
    // guard's business.
    expect(isRelayMessage(["EOSE", "sub", ["more"]])).toBe(true);
    expect(isRelayMessage(["NOTICE", "hi", "extra"])).toBe(true);
  });

  it("rejects a non-string id where the type promises one", () => {
    expect(isRelayMessage(["EVENT", 5])).toBe(false);
    expect(isRelayMessage(["OK", null, true, ""])).toBe(false);
    expect(isRelayMessage(["EOSE", 5])).toBe(false);
  });
});

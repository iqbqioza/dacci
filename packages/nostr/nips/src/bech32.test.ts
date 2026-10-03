import { describe, expect, it } from "vitest";
import { bech32Decode, bech32Encode } from "./bech32.js";

describe("bech32Decode", () => {
  it("round-trips what it encodes", () => {
    const data = new Uint8Array([0, 1, 2, 250, 255]);
    const encoded = bech32Encode("npub", data);
    expect(encoded.startsWith("npub1")).toBe(true);
    expect(bech32Decode(encoded)).toEqual({ hrp: "npub", data });
  });

  it("rejects mixed case, which has no checksum to check", () => {
    const encoded = bech32Encode("npub", new Uint8Array([1, 2, 3]));
    const mixed = encoded.slice(0, 6).toUpperCase() + encoded.slice(6);
    expect(bech32Decode(mixed)).toBeNull();
    // All upper case is valid BIP-173 and reads back lower.
    expect(bech32Decode(encoded.toUpperCase())?.hrp).toBe("npub");
  });

  it("rejects a checksum that does not verify", () => {
    const encoded = bech32Encode("npub", new Uint8Array([1, 2, 3]));
    const last = encoded.slice(-1) === "a" ? "b" : "a";
    expect(bech32Decode(encoded.slice(0, -1) + last)).toBeNull();
  });

  it("allows the long references NIP-19 needs, past BIP-173's cap", () => {
    // BIP-173 stops at 90 characters; an `nevent` carrying relay hints is
    // longer, so NIP-19 raises the cap to 5000 and anything past it is refused.
    const data = new Uint8Array(100).fill(7);
    const encoded = bech32Encode("nevent", data);
    expect(encoded.length).toBeGreaterThan(90);
    expect(bech32Decode(encoded)?.hrp).toBe("nevent");
  });
});

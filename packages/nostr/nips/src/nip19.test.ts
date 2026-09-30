import { describe, expect, it } from "vitest";
import { bech32Decode, bech32Encode } from "./bech32.js";
import {
  decodeNote,
  decodeNpub,
  decodeNsec,
  encodeNote,
  encodeNpub,
  encodeNsec,
} from "./nip19.js";

const KEY = "3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d";

describe("bech32", () => {
  it("round-trips bytes", () => {
    const bytes = new Uint8Array(32).fill(7);
    const decoded = bech32Decode(bech32Encode("test", bytes));
    expect(decoded?.hrp).toBe("test");
    expect([...(decoded?.data ?? [])]).toEqual([...bytes]);
  });

  it("rejects a tampered checksum and garbage", () => {
    const encoded = bech32Encode("test", new Uint8Array(32));
    const tampered = `${encoded.slice(0, -1)}${encoded.at(-1) === "q" ? "p" : "q"}`;
    expect(bech32Decode(tampered)).toBeNull();
    expect(bech32Decode("not-bech32")).toBeNull();
  });
});

describe("NIP-19 entities", () => {
  it("encodes a pubkey as npub and back", () => {
    const npub = encodeNpub(KEY);
    expect(npub).toMatch(/^npub1[023456789acdefghjklmnpqrstuvwxyz]+$/);
    expect(decodeNpub(npub as string)).toBe(KEY);
  });

  it("encodes an event id as note and a secret key as nsec", () => {
    expect(decodeNote(encodeNote(KEY) as string)).toBe(KEY);
    expect(decodeNsec(encodeNsec(KEY) as string)).toBe(KEY);
  });

  it("keeps the prefixes apart", () => {
    const npub = encodeNpub(KEY) as string;
    expect(decodeNsec(npub)).toBeNull();
    expect(decodeNpub(encodeNsec(KEY) as string)).toBeNull();
    expect(decodeNote(npub)).toBeNull();
  });

  it("refuses non-32-byte hex and malformed entities", () => {
    expect(encodeNpub("abc")).toBeNull();
    expect(encodeNpub("ZZ".repeat(32))).toBeNull();
    expect(decodeNpub("npub1")).toBeNull();
    expect(decodeNpub("npub1notarealnpub1xyz")).toBeNull();
  });
});

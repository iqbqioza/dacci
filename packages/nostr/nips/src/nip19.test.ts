import { describe, expect, it } from "vitest";
import { bech32Decode, bech32Encode } from "./bech32.js";
import {
  decodeEventReference,
  decodeNote,
  decodeNevent,
  decodeNpub,
  decodeNsec,
  encodeNote,
  encodeNpub,
  encodeNsec,
} from "./nip19.js";

const KEY = "3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d";
const OTHER = "7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e";

/** A NIP-19 TLV stream from `[type, value]` pairs. */
function tlv(entries: Array<[number, number[]]>): Uint8Array {
  const bytes: number[] = [];
  for (const [type, value] of entries) {
    bytes.push(type, value.length, ...value);
  }
  return new Uint8Array(bytes);
}

/** Hex to bytes, two characters at a time. */
function bytesOf(hex: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hex.length; i += 2) {
    out.push(parseInt(hex.slice(i, i + 2), 16));
  }
  return out;
}
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

describe("decodeNevent", () => {
  it("reads the event id from TLV type 0", () => {
    const encoded = bech32Encode("nevent", tlv([[0, bytesOf(KEY)]]));
    expect(decodeNevent(encoded)).toEqual({ id: KEY, relays: [] });
  });

  it("reads the relay, author and kind hints", () => {
    const relay = [...new TextEncoder().encode("wss://relay.example")];
    const encoded = bech32Encode(
      "nevent",
      tlv([
        [0, bytesOf(KEY)],
        [1, relay],
        [2, bytesOf(OTHER)],
        [3, [0, 0, 0, 1]],
      ]),
    );
    expect(decodeNevent(encoded)).toEqual({
      id: KEY,
      relays: ["wss://relay.example"],
      author: OTHER,
      kind: 1,
    });
  });

  it("ignores TLV types it does not know", () => {
    const encoded = bech32Encode(
      "nevent",
      tlv([
        [0, bytesOf(KEY)],
        [9, [1, 2, 3]],
      ]),
    );
    expect(decodeNevent(encoded)?.id).toBe(KEY);
  });

  it("rejects an entity with no id, since nothing can be resolved", () => {
    const encoded = bech32Encode("nevent", tlv([[1, [1, 2, 3]]]));
    expect(decodeNevent(encoded)).toBeNull();
  });

  it("stops at a truncated TLV entry instead of guessing", () => {
    // Type 0 claims 32 bytes but supplies 4, then a valid-looking tail.
    const encoded = bech32Encode(
      "nevent",
      new Uint8Array([0, 32, 1, 2, 3, 4, 0, 0, 0, 0]),
    );
    expect(decodeNevent(encoded)).toBeNull();
  });

  it("ignores an id TLV of the wrong length", () => {
    const encoded = bech32Encode("nevent", tlv([[0, [1, 2, 3]]]));
    expect(decodeNevent(encoded)).toBeNull();
  });

  it("keeps the prefixes apart", () => {
    expect(decodeNevent(encodeNote(KEY) as string)).toBeNull();
  });
});

describe("decodeEventReference", () => {
  it("resolves every form a client writes for one event", () => {
    expect(decodeEventReference(encodeNote(KEY) as string)).toBe(KEY);
    expect(decodeEventReference(`nostr:${encodeNote(KEY)}`)).toBe(KEY);
    const nevent = bech32Encode("nevent", tlv([[0, bytesOf(KEY)]]));
    expect(decodeEventReference(`nostr:${nevent}`)).toBe(KEY);
  });

  it("accepts the non-standard event1 prefix some clients emit", () => {
    const odd = bech32Encode("event", new Uint8Array(bytesOf(KEY)));
    expect(decodeEventReference(`nostr:${odd}`)).toBe(KEY);
  });

  it("rejects an entity about a profile or an address", () => {
    // A profile reference names a person, not a post, so it has no event id.
    const profile = bech32Encode("nprofile", tlv([[0, bytesOf(KEY)]]));
    expect(decodeEventReference(`nostr:${profile}`)).toBeNull();
  });

  it("rejects prose and tampered checksums", () => {
    expect(decodeEventReference("note1thisisnotarealnotereference")).toBeNull();
    const note = encodeNote(KEY) as string;
    expect(decodeEventReference(`${note.slice(0, -1)}q`)).toBeNull();
  });
});

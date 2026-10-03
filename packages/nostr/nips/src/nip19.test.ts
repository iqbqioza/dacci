import { describe, expect, it } from "vitest";
import { bech32Decode, bech32Encode } from "./bech32.js";
import {
  decodeEventReference,
  decodeNaddr,
  decodeNote,
  decodeNevent,
  decodeNprofile,
  decodeNpub,
  decodeNrelay,
  decodeNsec,
  decodeProfileReference,
  encodeNote,
  encodeNpub,
  encodeNsec,
} from "./nip19.js";

const KEY = "3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d";
const OTHER = "7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e";

/** A NIP-19 TLV stream from `[type, value]` pairs. */
function tlv(entries: Array<[number, number[] | Uint8Array]>): Uint8Array {
  const bytes: number[] = [];
  for (const [type, value] of entries) {
    const part = typeof value === "number" ? undefined : [...value];
    bytes.push(type, (part ?? value).length, ...(part ?? value));
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

describe("nprofile", () => {
  it("reads the pubkey and the relay hints", () => {
    // NIP-27 asks writers to mention a profile with this, so a client that
    // cannot read it shows the reader raw bech32.
    const encoded = bech32Encode(
      "nprofile",
      tlv([
        [0, bytesOf(KEY)],
        [1, [...new TextEncoder().encode("wss://one.example")]],
        [1, [...new TextEncoder().encode("wss://two.example")]],
      ]),
    );
    expect(decodeNprofile(encoded)).toEqual({
      pubkey: KEY,
      relays: ["wss://one.example", "wss://two.example"],
    });
  });

  it("reads one with no relay hints at all", () => {
    const encoded = bech32Encode("nprofile", tlv([[0, bytesOf(KEY)]]));
    expect(decodeNprofile(encoded)).toEqual({ pubkey: KEY, relays: [] });
  });

  it("rejects one with no key, since there is nobody to show", () => {
    const encoded = bech32Encode(
      "nprofile",
      tlv([[1, [...new TextEncoder().encode("wss://one.example")]]]),
    );
    expect(decodeNprofile(encoded)).toBeNull();
  });

  it("rejects a key of the wrong length", () => {
    expect(decodeNprofile(bech32Encode("nprofile", tlv([[0, [1, 2, 3]]])))).toBeNull();
  });

  it("keeps the prefixes apart", () => {
    expect(decodeNprofile(encodeNpub(KEY) as string)).toBeNull();
    expect(decodeNpub(bech32Encode("nprofile", tlv([[0, bytesOf(KEY)]])))).toBeNull();
  });
});

describe("naddr", () => {
  /** TLV 3 is a big-endian uint32. */
  const kind = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

  it("reads the coordinate of an addressable event", () => {
    const encoded = bech32Encode(
      "naddr",
      tlv([
        [0, [...new TextEncoder().encode("my-article")]],
        [1, [...new TextEncoder().encode("wss://one.example")]],
        [2, bytesOf(KEY)],
        [3, kind(30023)],
      ]),
    );
    expect(decodeNaddr(encoded)).toEqual({
      identifier: "my-article",
      pubkey: KEY,
      kind: 30023,
      relays: ["wss://one.example"],
    });
  });

  it("reads the empty identifier a replaceable kind uses", () => {
    // The `special` type is the identifier here, and for a parameterised
    // replaceable event it is an empty string — so it cannot be held to the 32
    // bytes the same type means for nprofile and nevent.
    const encoded = bech32Encode(
      "naddr",
      tlv([
        [0, []],
        [2, bytesOf(KEY)],
        [3, kind(30023)],
      ]),
    );
    expect(decodeNaddr(encoded)).toEqual({
      identifier: "",
      pubkey: KEY,
      kind: 30023,
      relays: [],
    });
  });

  it("refuses text that is not text, rather than replacing it", () => {
    // NIP-19: a relay hint is "encoded as ascii", and an `naddr` identifier is
    // the event's own `d` value, which is UTF-8. Bytes that are neither are not
    // that text, and a non-fatal decode turned them into U+FFFD: the client then
    // queried a coordinate with a replacement character in it, or asked a relay
    // whose name is three diamonds. Silent and wrong beats refused only when the
    // wrong answer happens to be useful, which here it never is.
    const bad = new Uint8Array([0xff, 0xfe, 0x80]);

    // The identifier is mandatory, so an `naddr` carrying it is malformed.
    const naddr = bech32Encode(
      "naddr",
      tlv([
        [0, bad],
        [2, bytesOf(KEY)],
        [3, kind(30023)],
      ]),
    );
    expect(decodeNaddr(naddr)).toBeNull();

    // A relay hint is not mandatory: skipped, the way any TLV this reader does
    // not understand is, and the rest of the entity still resolves.
    const withBadRelay = bech32Encode(
      "naddr",
      tlv([
        [0, new TextEncoder().encode("my-article")],
        [1, bad],
        [1, new TextEncoder().encode("wss://one.example")],
        [2, bytesOf(KEY)],
        [3, kind(30023)],
      ]),
    );
    expect(decodeNaddr(withBadRelay)).toEqual({
      identifier: "my-article",
      pubkey: KEY,
      kind: 30023,
      relays: ["wss://one.example"],
    });

    // Same for the other two, and for the whole payload of an `nrelay`.
    const nevent = bech32Encode(
      "nevent",
      tlv([
        [0, new Uint8Array(32).fill(3)],
        [1, bad],
      ]),
    );
    expect(decodeNevent(nevent)?.relays).toEqual([]);
    const nprofile = bech32Encode(
      "nprofile",
      tlv([
        [0, bytesOf(KEY)],
        [1, bad],
      ]),
    );
    expect(decodeNprofile(nprofile)?.relays).toEqual([]);
    expect(decodeNrelay(bech32Encode("nrelay", bad))).toBeNull();

    // And valid text still reads, including non-ASCII in a `d` tag, which UTF-8
    // covers and ascii does not.
    expect(
      decodeNaddr(
        bech32Encode(
          "naddr",
          tlv([
            [0, new TextEncoder().encode("論文")],
            [2, bytesOf(KEY)],
            [3, kind(30023)],
          ]),
        ),
      )?.identifier,
    ).toBe("論文");
  });

  it("rejects a coordinate missing any part of it", () => {
    // Without the identifier, the author or the kind, the address names nothing
    // that can be asked for.
    expect(decodeNaddr(bech32Encode("naddr", tlv([[2, bytesOf(KEY)], [3, kind(1)]])))).toBeNull();
    expect(decodeNaddr(bech32Encode("naddr", tlv([[0, [1]], [3, kind(1)]])))).toBeNull();
    expect(decodeNaddr(bech32Encode("naddr", tlv([[0, [1]], [2, bytesOf(KEY)]])))).toBeNull();
  });

  it("keeps the prefixes apart", () => {
    expect(
      decodeNaddr(bech32Encode("nevent", tlv([[0, bytesOf(KEY)]]))),
    ).toBeNull();
  });
});

describe("nrelay", () => {
  it("reads the URL it wraps", () => {
    // Deprecated by NIP-19, but a reference a client was handed should resolve
    // rather than be shown as raw text.
    const encoded = bech32Encode(
      "nrelay",
      new TextEncoder().encode("wss://relay.example"),
    );
    expect(decodeNrelay(encoded)).toBe("wss://relay.example");
  });

  it("rejects an empty one, which names no relay", () => {
    expect(decodeNrelay(bech32Encode("nrelay", new Uint8Array([])))).toBeNull();
  });
});

describe("decodeProfileReference", () => {
  it("takes either spelling a mention is written in", () => {
    const profile = bech32Encode("nprofile", tlv([[0, bytesOf(KEY)]]));
    expect(decodeProfileReference(encodeNpub(KEY) as string)).toBe(KEY);
    expect(decodeProfileReference(profile)).toBe(KEY);
  });

  it("takes the nostr: prefix off either one", () => {
    const profile = bech32Encode("nprofile", tlv([[0, bytesOf(KEY)]]));
    expect(decodeProfileReference(`nostr:${profile}`)).toBe(KEY);
    expect(decodeProfileReference(`nostr:${encodeNpub(KEY) as string}`)).toBe(KEY);
  });

  it("takes an entity whose checksum does not hold as naming nobody", () => {
    // The checksum is what decides whether a word is a reference at all, so a
    // string that merely begins like one must not resolve.
    expect(decodeProfileReference("npub1notarealkey")).toBeNull();
    expect(decodeProfileReference("nprofile1nope")).toBeNull();
  });

  it("takes an event reference as naming nobody", () => {
    expect(decodeProfileReference(encodeNote(KEY) as string)).toBeNull();
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

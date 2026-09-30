import { schnorr } from "@noble/curves/secp256k1";
import { hexToBytes } from "@noble/hashes/utils";
import { describe, expect, it, vi } from "vitest";
import { bech32Decode, bech32Encode } from "./bech32.js";
import {
  decodeNsec,
  hasNip07Extension,
  Nip07Signer,
  NsecSigner,
} from "./signer.js";

describe("bech32", () => {
  it("round-trips 32 bytes with checksum verification", () => {
    const bytes = new Uint8Array(32).map((_, i) => i);
    const encoded = bech32Encode("nsec", bytes);
    expect(encoded.startsWith("nsec1")).toBe(true);
    const decoded = bech32Decode(encoded);
    expect(decoded?.hrp).toBe("nsec");
    expect([...(decoded?.data ?? [])]).toEqual([...bytes]);
  });

  it("rejects tampered strings", () => {
    const bytes = new Uint8Array(32).map((_, i) => i * 3);
    const encoded = bech32Encode("nsec", bytes);
    const tampered =
      encoded.slice(0, -2) + (encoded.endsWith("q") ? "p" : "q");
    expect(bech32Decode(tampered)).toBeNull();
    expect(bech32Decode("not-bech32")).toBeNull();
  });
});

describe("decodeNsec", () => {
  it("decodes a valid nsec and rejects others", () => {
    const secret = "11".repeat(32);
    const nsec = bech32Encode(
      "nsec",
      Uint8Array.from({ length: 32 }, () => 0x11),
    );
    expect(decodeNsec(nsec)).toBe(secret);
    expect(decodeNsec("npub1xyz")).toBeNull();
    expect(decodeNsec("nsec1invalid")).toBeNull();
  });
});

describe("NsecSigner", () => {
  it("signs events verifiable by schnorr", async () => {
    const signer = new NsecSigner("22".repeat(32));
    const pubkey = await signer.getPublicKey();
    const event = await signer.signEvent({
      pubkey,
      created_at: 1000,
      kind: 1,
      tags: [],
      content: "hi",
    });
    expect(event.pubkey).toBe(pubkey);
    expect(
      schnorr.verify(hexToBytes(event.sig), hexToBytes(event.id), pubkey),
    ).toBe(true);
  });

  it("rejects malformed keys", () => {
    expect(() => new NsecSigner("zz")).toThrow();
  });
});

describe("Nip07Signer", () => {
  it("detects a missing extension", () => {
    expect(hasNip07Extension()).toBe(false);
  });

  it("delegates to window.nostr", async () => {
    const signed = {
      id: "a".repeat(64),
      pubkey: "b".repeat(64),
      created_at: 1,
      kind: 1,
      tags: [],
      content: "",
      sig: "c".repeat(128),
    };
    vi.stubGlobal("nostr", {
      getPublicKey: async () => "b".repeat(64),
      signEvent: async () => signed,
    });
    try {
      expect(hasNip07Extension()).toBe(true);
      const signer = new Nip07Signer();
      expect(await signer.getPublicKey()).toBe("b".repeat(64));
      expect(await signer.signEvent({
        pubkey: "b".repeat(64),
        created_at: 1,
        kind: 1,
        tags: [],
        content: "",
      })).toBe(signed);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

import { schnorr } from "@noble/curves/secp256k1";
import { hexToBytes } from "@noble/hashes/utils";
import { describe, expect, it, vi } from "vitest";
import { bech32Decode, bech32Encode } from "dacci-nostr-nips";
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
    // A real signature, because the signer now checks that what comes back
    // is the template it asked for: a fixed fake event is refused below.
    const real = new NsecSigner("22".repeat(32));
    const pubkey = await real.getPublicKey();
    vi.stubGlobal("nostr", {
      getPublicKey: async () => pubkey,
      signEvent: async (template: unknown) =>
        real.signEvent(template as Parameters<NsecSigner["signEvent"]>[0]),
    });
    try {
      expect(hasNip07Extension()).toBe(true);
      const signer = new Nip07Signer();
      expect(await signer.getPublicKey()).toBe(pubkey);
      const template = {
        pubkey,
        created_at: 1,
        kind: 1,
        tags: [],
        content: "",
      };
      expect((await signer.signEvent(template)).id).toBe(
        (await real.signEvent(template)).id,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refuses an event that is not what was asked for", async () => {
    // A buggy or hostile extension handing back another event — valid id for
    // *those* fields, valid signature and all — would otherwise be published
    // as the reader's own words.
    const real = new NsecSigner("22".repeat(32));
    const pubkey = await real.getPublicKey();
    const template = { pubkey, created_at: 1, kind: 1, tags: [], content: "" };
    const genuine = await real.signEvent(template);
    const cases: Array<[string, unknown]> = [
      ["other content", { ...genuine, content: "attacker words" }],
      ["other author", { ...genuine, pubkey: "b".repeat(64) }],
      ["other kind", { ...genuine, kind: 7 }],
      [
        "recomputed id, still not asked for",
        await real.signEvent({ ...template, content: "attacker words" }),
      ],
    ];
    for (const [name, handed] of cases) {
      vi.stubGlobal("nostr", {
        getPublicKey: async () => pubkey,
        signEvent: async () => handed,
      });
      try {
        await expect(
          new Nip07Signer().signEvent(template),
          name,
        ).rejects.toThrow("does not match");
      } finally {
        vi.unstubAllGlobals();
      }
    }
  });
});

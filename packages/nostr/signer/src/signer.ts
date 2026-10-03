import { schnorr } from "@noble/curves/secp256k1";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import {
  decodeNsec as decodeNsecEntity,
  hasValidId,
  hasValidSignature,
  isHex64,
  signAuthEvent,
  signEvent,
  type NostrEvent,
  type UnsignedEvent,
} from "dacci-nostr-nips";

/** Unified signing capability: NIP-07 extension or local nsec key. */
export interface Signer {
  getPublicKey(): Promise<string>;
  signEvent(template: UnsignedEvent): Promise<NostrEvent>;
  signAuth(challenge: string, relayUrl: string): Promise<NostrEvent>;
}

/** Decode an nsec1 string to 32-byte secret key hex. Null when invalid. */
export function decodeNsec(nsec: string): string | null {
  if (!nsec.trim().startsWith("nsec1")) return null;
  return decodeNsecEntity(nsec);
}

/** Signer backed by a local secret key. The key never leaves memory. */
export class NsecSigner implements Signer {
  private readonly pubkey: string;

  constructor(private readonly secretKeyHex: string) {
    if (!/^[0-9a-f]{64}$/.test(secretKeyHex)) {
      throw new Error("secret key must be 32-byte lowercase hex");
    }
    this.pubkey = bytesToHex(
      schnorr.getPublicKey(hexToBytes(secretKeyHex)),
    );
  }

  async getPublicKey(): Promise<string> {
    return this.pubkey;
  }

  async signEvent(template: UnsignedEvent): Promise<NostrEvent> {
    return signEvent(template, this.secretKeyHex);
  }

  async signAuth(challenge: string, relayUrl: string): Promise<NostrEvent> {
    return signAuthEvent(challenge, relayUrl, {
      secretKeyHex: this.secretKeyHex,
      pubkey: this.pubkey,
    });
  }
}

/** Minimal NIP-07 provider surface. */
export interface Nip07Provider {
  getPublicKey(): Promise<string>;
  signEvent(event: UnsignedEvent): Promise<NostrEvent>;
}

function getProvider(): Nip07Provider | null {
  const w = globalThis as { nostr?: unknown };
  if (typeof w.nostr !== "object" || w.nostr === null) return null;
  const provider = w.nostr as Partial<Nip07Provider>;
  if (
    typeof provider.getPublicKey !== "function" ||
    typeof provider.signEvent !== "function"
  ) {
    return null;
  }
  return provider as Nip07Provider;
}

export function hasNip07Extension(): boolean {
  return getProvider() !== null;
}

/** Signer delegating to a NIP-07 browser extension. */
export class Nip07Signer implements Signer {
  async getPublicKey(): Promise<string> {
    const provider = getProvider();
    if (provider === null) throw new Error("NIP-07 extension not found");
    const pubkey = await provider.getPublicKey();
    if (!isHex64(pubkey)) throw new Error("extension returned invalid pubkey");
    return pubkey;
  }

  async signEvent(template: UnsignedEvent): Promise<NostrEvent> {
    const provider = getProvider();
    if (provider === null) throw new Error("NIP-07 extension not found");
    const signed = await provider.signEvent(template);
    // What comes back is published under the reader's name, so it is checked
    // to be the template that was asked for — same fields, valid id, valid
    // signature. A buggy or hostile extension handing back another event
    // would otherwise go out as the reader's own words, and nothing
    // downstream could tell: the id would be valid for *those* fields.
    if (
      signed.pubkey !== template.pubkey ||
      signed.kind !== template.kind ||
      signed.created_at !== template.created_at ||
      signed.content !== template.content ||
      JSON.stringify(signed.tags) !== JSON.stringify(template.tags) ||
      !hasValidId(signed) ||
      !hasValidSignature(signed)
    ) {
      throw new Error("extension returned an event that does not match");
    }
    return signed;
  }

  async signAuth(challenge: string, relayUrl: string): Promise<NostrEvent> {
    const pubkey = await this.getPublicKey();
    return this.signEvent({
      pubkey,
      created_at: Math.floor(Date.now() / 1000),
      kind: 22242,
      tags: [
        ["relay", relayUrl],
        ["challenge", challenge],
      ],
      content: "",
    });
  }
}

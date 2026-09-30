import { schnorr } from "@noble/curves/secp256k1";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import {
  isHex64,
  signAuthEvent,
  signEvent,
  type NostrEvent,
  type UnsignedEvent,
} from "dacci-nostr-nips";
import { bech32Decode } from "./bech32.js";

/** Unified signing capability: NIP-07 extension or local nsec key. */
export interface Signer {
  getPublicKey(): Promise<string>;
  signEvent(template: UnsignedEvent): Promise<NostrEvent>;
  signAuth(challenge: string, relayUrl: string): Promise<NostrEvent>;
}

/** Decode an nsec1 string to 32-byte secret key hex. Null when invalid. */
export function decodeNsec(nsec: string): string | null {
  const trimmed = nsec.trim();
  if (!trimmed.startsWith("nsec1")) return null;
  const decoded = bech32Decode(trimmed);
  if (decoded === null || decoded.hrp !== "nsec") return null;
  if (decoded.data.length !== 32) return null;
  return bytesToHex(decoded.data);
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
    return provider.signEvent(template);
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

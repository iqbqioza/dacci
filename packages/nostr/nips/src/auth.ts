import { schnorr } from "@noble/curves/secp256k1";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { computeEventId, isHex64, type NostrEvent } from "./event.js";

/** NIP-42 auth event kind. */
export const AUTH_EVENT_KIND = 22242;

export interface AuthSecret {
  /** 32-byte secp256k1 secret key, lowercase hex. */
  secretKeyHex: string;
  /** 32-byte x-only pubkey, lowercase hex. */
  pubkey: string;
}

export function isValidAuthSecret(secret: unknown): secret is AuthSecret {
  if (typeof secret !== "object" || secret === null) return false;
  const s = secret as Record<string, unknown>;
  return (
    typeof s.secretKeyHex === "string" &&
    /^[0-9a-f]{64}$/.test(s.secretKeyHex) &&
    isHex64(s.pubkey)
  );
}

export interface UnsignedEvent {
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
}

export function signEvent(
  template: UnsignedEvent,
  secretKeyHex: string,
): NostrEvent {
  const id = computeEventId(template);
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), hexToBytes(secretKeyHex)));
  return { ...template, id, sig };
}

/**
 * Build and sign a NIP-42 AUTH response event.
 * Tags MUST be [["relay", url], ["challenge", challenge]] with empty content.
 */
export function signAuthEvent(
  challenge: string,
  relayUrl: string,
  secret: AuthSecret,
  createdAt: number = Math.floor(Date.now() / 1000),
): NostrEvent {
  return signEvent(
    {
      pubkey: secret.pubkey,
      created_at: createdAt,
      kind: AUTH_EVENT_KIND,
      tags: [
        ["relay", relayUrl],
        ["challenge", challenge],
      ],
      content: "",
    },
    secret.secretKeyHex,
  );
}

/** True for CLOSED machine-readable prefix "auth-required:". */
export function isAuthRequiredMessage(message: string): boolean {
  return message.startsWith("auth-required:");
}

import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { isHex64 } from "./event.js";
import { bech32Decode, bech32Encode } from "./bech32.js";

/**
 * NIP-19 bech32 entities. Every entity is a 32-byte value: a pubkey
 * (`npub`), an event id (`note`) or a secret key (`nsec`).
 */

function encode32(hrp: string, hex: string): string | null {
  if (!isHex64(hex)) return null;
  return bech32Encode(hrp, hexToBytes(hex));
}

function decode32(hrp: string, value: string): string | null {
  const decoded = bech32Decode(value.trim());
  if (decoded === null || decoded.hrp !== hrp) return null;
  if (decoded.data.length !== 32) return null;
  return bytesToHex(decoded.data);
}

/** Encode a 32-byte hex value as npub1… */
export function encodeNpub(pubkey: string): string | null {
  return encode32("npub", pubkey);
}

/** Decode npub1… back to a 32-byte hex pubkey. Null when invalid. */
export function decodeNpub(npub: string): string | null {
  return decode32("npub", npub);
}

/** Encode a 32-byte hex event id as note1… */
export function encodeNote(eventId: string): string | null {
  return encode32("note", eventId);
}

/** Decode note1… back to a 32-byte hex event id. Null when invalid. */
export function decodeNote(note: string): string | null {
  return decode32("note", note);
}

/** Encode a 32-byte hex secret key as nsec1… */
export function encodeNsec(secretKeyHex: string): string | null {
  return encode32("nsec", secretKeyHex);
}

/** Decode nsec1… back to a 32-byte hex secret key. Null when invalid. */
export function decodeNsec(secretKeyHex: string): string | null {
  return decode32("nsec", secretKeyHex);
}

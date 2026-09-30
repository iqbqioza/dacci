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

/** What a NIP-19 `nevent` points at. Relay hints and author are optional. */
export interface Nevent {
  /** Hex id of the referenced event. */
  id: string;
  /** Relays the sharer thought likely to have it. */
  relays: string[];
  /** Hex pubkey of the author, when the sharer included it. */
  author?: string;
  /** Kind of the referenced event, when the sharer included it. */
  kind?: number;
}

/** One NIP-19 TLV entry: a 1-byte type, a 1-byte length, then the value. */
interface Tlv {
  type: number;
  value: Uint8Array;
}

/** Splits a TLV stream, stopping at the first malformed entry. */
function parseTlv(data: Uint8Array): Tlv[] {
  const out: Tlv[] = [];
  let at = 0;
  while (at + 2 <= data.length) {
    const type = data[at];
    const length = data[at + 1];
    const start = at + 2;
    const end = start + length;
    // A truncated entry means the rest cannot be trusted either.
    if (end > data.length) break;
    out.push({ type, value: data.slice(start, end) });
    at = end;
  }
  return out;
}

/**
 * Decode `nevent1…` back to the event it references. Per NIP-19, TLV types a
 * client does not recognise are ignored rather than treated as an error.
 */
export function decodeNevent(nevent: string): Nevent | null {
  const decoded = bech32Decode(nevent.trim());
  if (decoded === null || decoded.hrp !== "nevent") return null;
  let id: string | null = null;
  const relays: string[] = [];
  let author: string | undefined;
  let kind: number | undefined;
  for (const { type, value } of parseTlv(decoded.data)) {
    if (type === 0 && value.length === 32) {
      // The id is mandatory; a later one wins only if the first was absent.
      id ??= bytesToHex(value);
    } else if (type === 1) {
      relays.push(new TextDecoder().decode(value));
    } else if (type === 2 && value.length === 32) {
      author = bytesToHex(value);
    } else if (type === 3 && value.length === 4) {
      // uint32 big-endian, per NIP-19.
      kind =
        ((value[0] << 24) | (value[1] << 16) | (value[2] << 8) | value[3]) >>> 0;
    }
  }
  // Without the id there is nothing to resolve, so the whole entity is void.
  if (id === null) return null;
  return { id, relays, ...(author === undefined ? {} : { author }), ...(kind === undefined ? {} : { kind }) };
}

/**
 * The entity inside a `nostr:` URI, which NIP-19 defines as the scheme
 * followed by the entity. A bare entity is returned unchanged.
 */
function stripScheme(reference: string): string {
  const value = reference.trim();
  return value.toLowerCase().startsWith("nostr:")
    ? value.slice("nostr:".length)
    : value;
}

/**
 * Decode any NIP-19 reference to a single event and return just its hex id.
 * Accepts `note1…`, `nevent1…`, and the non-standard `event1…` that some
 * clients emit, each with or without the `nostr:` scheme. The bech32 checksum
 * is what decides whether a string is real, so a word that merely starts with
 * those letters decodes to null.
 */
export function decodeEventReference(reference: string): string | null {
  const value = stripScheme(reference);
  const hrp = bech32Decode(value)?.hrp;
  if (hrp === "note" || hrp === "event") return decode32(hrp, value);
  if (hrp === "nevent") return decodeNevent(value)?.id ?? null;
  return null;
}

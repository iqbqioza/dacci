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

/** uint32 big-endian, per NIP-19's `kind` TLV. */
function readUint32(value: Uint8Array): number {
  return (
    ((value[0] << 24) | (value[1] << 16) | (value[2] << 8) | value[3]) >>> 0
  );
}

/** What a NIP-19 `nprofile` points at: a pubkey and where to find it. */
export interface Nprofile {
  /** Hex pubkey of the profile's author. */
  pubkey: string;
  /** Relays the sharer thought likely to have it. */
  relays: string[];
}

/**
 * Decode `nprofile1…`. TLV 0 is the 32-byte pubkey and TLV 1 a relay, which may
 * appear more than once.
 *
 * NIP-27 asks writers to mention a profile with this rather than a bare `npub`,
 * so a client that cannot read it shows the reader raw bech32.
 */
export function decodeNprofile(nprofile: string): Nprofile | null {
  const decoded = bech32Decode(nprofile.trim());
  if (decoded === null || decoded.hrp !== "nprofile") return null;
  let pubkey: string | null = null;
  const relays: string[] = [];
  for (const { type, value } of parseTlv(decoded.data)) {
    if (type === 0 && value.length === 32) {
      pubkey ??= bytesToHex(value);
    } else if (type === 1) {
      relays.push(new TextDecoder().decode(value));
    }
  }
  // Without the key there is nobody to show, so the entity is void.
  if (pubkey === null) return null;
  return { pubkey, relays };
}

/** What a NIP-19 `naddr` points at: the coordinate of an addressable event. */
export interface Naddr {
  /** The event's `d` tag, empty for a parameterised replaceable kind. */
  identifier: string;
  /** Hex pubkey of the author. */
  pubkey: string;
  kind: number;
  relays: string[];
}

/**
 * Decode `naddr1…`. TLV 0 is the `d` identifier, 1 a relay, 2 the 32-byte
 * author and 3 the kind as a big-endian uint32.
 *
 * The identifier is not fixed-length — it is the event's own `d` value, and an
 * empty one is what a parameterised replaceable kind uses — so it is not held to
 * the 32 bytes the `special` type means for the other prefixes.
 */
export function decodeNaddr(naddr: string): Naddr | null {
  const decoded = bech32Decode(naddr.trim());
  if (decoded === null || decoded.hrp !== "naddr") return null;
  let identifier: string | null = null;
  let pubkey: string | null = null;
  let kind: number | null = null;
  const relays: string[] = [];
  for (const { type, value } of parseTlv(decoded.data)) {
    if (type === 0 && identifier === null) {
      identifier = new TextDecoder().decode(value);
    } else if (type === 1) {
      relays.push(new TextDecoder().decode(value));
    } else if (type === 2 && value.length === 32) {
      pubkey = bytesToHex(value);
    } else if (type === 3 && value.length === 4) {
      kind = readUint32(value);
    }
  }
  // All three are mandatory: an address without them does not identify anything.
  if (identifier === null || pubkey === null || kind === null) return null;
  return { identifier, pubkey, kind, relays };
}

/**
 * Decode `nrelay1…` back to the URL it wraps.
 *
 * Deprecated by NIP-19: a relay URL is not something to encode this way, and no
 * current writer emits it. It is read anyway, so a reference a client was handed
 * resolves instead of being shown as raw text.
 */
export function decodeNrelay(nrelay: string): string | null {
  const decoded = bech32Decode(nrelay.trim());
  if (decoded === null || decoded.hrp !== "nrelay") return null;
  const url = new TextDecoder().decode(decoded.data);
  return url === "" ? null : url;
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

/**
 * The pubkey any NIP-19 profile reference names, or null when it names none.
 *
 * Both spellings are accepted because NIP-27 asks writers to mention a profile
 * with `nprofile1…`, while a great deal of text in the wild still uses a bare
 * `npub1…`. The bech32 checksum is what decides whether a word is a real
 * reference at all, so anything else is left alone.
 */
export function decodeProfileReference(reference: string): string | null {
  const value = stripScheme(reference);
  const hrp = bech32Decode(value)?.hrp;
  if (hrp === "npub") return decode32("npub", value);
  if (hrp === "nprofile") return decodeNprofile(value)?.pubkey ?? null;
  return null;
}

import { schnorr } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";

/** NIP-01 event object as transmitted on the wire. */
export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

const HEX64 = /^[0-9a-f]{64}$/;

export function isHex64(value: unknown): value is string {
  return typeof value === "string" && HEX64.test(value);
}

function isTag(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string")
  );
}

/** Strict structural validation of a NIP-01 event (excluding signature). */
export function isValidEventStructure(event: unknown): event is NostrEvent {
  if (typeof event !== "object" || event === null) return false;
  const e = event as Record<string, unknown>;
  return (
    isHex64(e.id) &&
    isHex64(e.pubkey) &&
    Number.isInteger(e.created_at) &&
    (e.created_at as number) >= 0 &&
    Number.isInteger(e.kind) &&
    (e.kind as number) >= 0 &&
    (e.kind as number) <= 65535 &&
    Array.isArray(e.tags) &&
    (e.tags as unknown[]).every(isTag) &&
    typeof e.content === "string" &&
    typeof e.sig === "string" &&
    (e.sig as string).length === 128
  );
}

function serializeForId(
  pubkey: string,
  createdAt: number,
  kind: number,
  tags: string[][],
  content: string,
): string {
  // NIP-01: [0, pubkey, created_at, kind, tags, content] as compact JSON.
  return JSON.stringify([0, pubkey, createdAt, kind, tags, content]);
}

/** Recompute the event id per NIP-01. */
export function computeEventId(event: Omit<NostrEvent, "id" | "sig">): string {
  const serialized = serializeForId(
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  );
  return bytesToHex(sha256(new TextEncoder().encode(serialized)));
}

/** True when the embedded id matches the recomputed NIP-01 id. */
export function hasValidId(event: NostrEvent): boolean {
  return (
    computeEventId(event) === event.id.toLowerCase() &&
    event.id === event.id.toLowerCase()
  );
}

/**
 * True when the signature is the key's own Schnorr signature over the id.
 *
 * `hasValidId` only proves the id is the hash of the fields the author chose,
 * and `pubkey` is one of those fields. That is enough to catch an event whose
 * body was rewritten under an id someone else signed, and not enough to catch
 * an event whose author was swapped: recompute the id after changing `pubkey`
 * and it still matches. Only this says the key named signed it.
 *
 * Verification costs roughly 50µs, so it is applied where it buys something —
 * to an event that never crossed a socket, where no relay has vouched for it —
 * rather than to everything received.
 */
export function hasValidSignature(event: NostrEvent): boolean {
  try {
    return schnorr.verify(
      hexToBytes(event.sig),
      hexToBytes(event.id),
      hexToBytes(event.pubkey),
    );
  } catch {
    // A malformed hex or an out-of-range point is a signature that does not
    // verify, not a crash on the reader's feed.
    return false;
  }
}

/** Newest-first order: created_at desc, id asc (NIP-01 tie-break). */
export function compareEvents(a: NostrEvent, b: NostrEvent): number {
  if (a.created_at !== b.created_at) {
    return b.created_at - a.created_at;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

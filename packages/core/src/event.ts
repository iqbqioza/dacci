import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "./nip19";

export type EventTag = string[];

export interface EventTemplate {
  kind: number;
  created_at: number;
  tags: EventTag[];
  content: string;
}

export interface UnsignedEvent extends EventTemplate {
  pubkey: string;
}

export interface Event extends UnsignedEvent {
  id: string;
}

export interface SignedEvent extends Event {
  sig: string;
}

export function serializeEvent(event: UnsignedEvent): string {
  return JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ]);
}

export function getEventHash(event: UnsignedEvent): string {
  const serialized = serializeEvent(event);
  return bytesToHex(sha256(new TextEncoder().encode(serialized)));
}

export function signEvent(template: EventTemplate, secretKey: Uint8Array): SignedEvent {
  const pubkey = bytesToHex(schnorr.getPublicKey(secretKey));
  const event: UnsignedEvent = {
    ...template,
    pubkey,
  };
  const id = getEventHash(event);
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), secretKey));
  return { ...event, id, sig };
}

export function verifyEvent(event: SignedEvent): boolean {
  if (getEventHash(event) !== event.id) {
    return false;
  }
  return schnorr.verify(hexToBytes(event.sig), hexToBytes(event.id), hexToBytes(event.pubkey));
}
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

/**
 * True for the CLOSED machine-readable prefix "auth-required:".
 *
 * The reason is optional in NIP-01, so a relay may send `["CLOSED", <id>]` with
 * nothing after it. Reading the prefix off a missing reason threw, and the throw
 * came from inside the relay's message handler — which meant every step after it
 * was skipped: the query hung for its whole timeout instead of failing at once,
 * no CLOSE went back for the subscription the client had given up on, and the
 * live stream was neither dropped nor reported.
 */
export function isAuthRequiredMessage(message: string | undefined): boolean {
  return message?.startsWith("auth-required:") === true;
}

/** NIP-98 HTTP API auth event kind. */
export const HTTP_AUTH_EVENT_KIND = 27235;
/** Blossom (BUD-11) authorization token kind. */
export const BLOSSOM_AUTH_EVENT_KIND = 24242;

/** What a signed `Authorization` header must carry. */
export interface HttpAuth {
  /** Scheme and credentials, e.g. `Nostr <base64 event>`. */
  header: string;
  /** The signed event, for callers that need its id. */
  event: NostrEvent;
}

/**
 * Build a NIP-98 authorization for one HTTP request. A file storage server
 * checks the `u` and `method` tags against the request it received, so both
 * are required and must match exactly.
 */
export async function signHttpAuth(input: {
  method: string;
  url: string;
  /** 32-byte x-only pubkey of the signer. */
  pubkey: string;
  signEvent: (template: UnsignedEvent) => Promise<NostrEvent>;
  /** SHA-256 of the file, or of whatever else the header must bind. */
  payload?: Uint8Array;
  createdAt?: number;
}): Promise<HttpAuth> {
  const created_at = input.createdAt ?? Math.floor(Date.now() / 1000);
  const tags: string[][] = [
    ["u", input.url],
    ["method", input.method.toUpperCase()],
  ];
  if (input.payload !== undefined) tags.push(["payload", base64Of(input.payload)]);
  const event = await input.signEvent({
    pubkey: input.pubkey,
    created_at,
    kind: HTTP_AUTH_EVENT_KIND,
    tags,
    content: "",
  });
  return {
    // NIP-98 encodes the whole event as base64 after the scheme name.
    header: `Nostr ${base64(JSON.stringify(event))}`,
    event,
  };
}

/** How long a Blossom token stays valid. */
const BLOSSOM_TOKEN_TTL_SECONDS = 60 * 10;

/**
 * Build a Blossom authorization token. BUD-11 defines a different event from
 * NIP-98: kind 24242, a `t` verb naming the action, an `expiration` the
 * server checks, and an `x` tag naming the blob when the endpoint implies
 * one. A server validates all of these, so a NIP-98 header is refused.
 */
export async function signBlossomAuth(input: {
  /** The verb the endpoint requires, e.g. `upload`. */
  verb: string;
  /** 32-byte x-only pubkey of the signer. */
  pubkey: string;
  signEvent: (template: UnsignedEvent) => Promise<NostrEvent>;
  /** SHA-256 of the blob, required by most endpoints. */
  hashHex?: string;
  /** Host the token is scoped to; omitted means any server. */
  server?: string;
  /** Human readable note shown to the reader, per BUD-11. */
  content?: string;
  createdAt?: number;
}): Promise<HttpAuth> {
  const created_at = input.createdAt ?? Math.floor(Date.now() / 1000);
  const tags: string[][] = [
    ["t", input.verb],
    ["expiration", String(created_at + BLOSSOM_TOKEN_TTL_SECONDS)],
  ];
  if (input.hashHex !== undefined) tags.push(["x", input.hashHex]);
  if (input.server !== undefined) tags.push(["server", input.server]);
  const event = await input.signEvent({
    pubkey: input.pubkey,
    created_at,
    kind: BLOSSOM_AUTH_EVENT_KIND,
    tags,
    content: input.content ?? "",
  });
  return {
    // BUD-11 asks for base64url without padding, as JWT uses, and keeps the
    // `Nostr` scheme name. A server that decodes standard base64 accepts
    // this too, since the two alphabets differ only outside the token.
    header: `Nostr ${base64Url(JSON.stringify(event))}`,
    event,
  };
}

/** Base64 of raw bytes, for a NIP-98 tag value. */
function base64Of(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Base64 of a UTF-8 string, for the NIP-98 header itself. */
export function base64(value: string): string {
  return base64Of(new TextEncoder().encode(value));
}

/**
 * Base64url without padding, which is what BUD-11 specifies for its token.
 * The standard alphabet and the url-safe one differ only in `+` and `/`,
 * which become `-` and `_`.
 */
export function base64Url(value: string): string {
  return base64(value)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

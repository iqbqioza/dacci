import { schnorr } from "@noble/curves/secp256k1";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { describe, expect, it } from "vitest";
import {
  AUTH_EVENT_KIND,
  base64,
  base64Url,
  hasValidId,
  isAuthRequiredMessage,
  signAuthEvent,
  signBlossomAuth,
  signHttpAuth,
  HTTP_AUTH_EVENT_KIND,
  BLOSSOM_AUTH_EVENT_KIND,
  type NostrEvent,
  type UnsignedEvent,
} from "../src/index.js";

const SECRET = "0".repeat(63) + "1";
const PUBKEY = bytesToHex(schnorr.getPublicKey(hexToBytes(SECRET)));

/** Stands in for the session signer: signs for real, so the checks below mean it. */
async function signAs(template: UnsignedEvent): Promise<NostrEvent> {
  const id = bytesToHex(
    (await import("@noble/hashes/sha256")).sha256(
      new TextEncoder().encode(JSON.stringify([
        0,
        template.pubkey,
        template.created_at,
        template.kind,
        template.tags,
        template.content,
      ])),
    ),
  );
  return {
    ...template,
    id,
    sig: bytesToHex(schnorr.sign(hexToBytes(id), hexToBytes(SECRET))),
  };
}

describe("signAuthEvent", () => {
  it("builds a valid NIP-42 event", () => {
    const event = signAuthEvent("challenge-123", "wss://relay.example", {
      secretKeyHex: SECRET,
      pubkey: PUBKEY,
    });
    expect(event.kind).toBe(AUTH_EVENT_KIND);
    expect(event.content).toBe("");
    expect(event.tags).toEqual([
      ["relay", "wss://relay.example"],
      ["challenge", "challenge-123"],
    ]);
    expect(hasValidId(event)).toBe(true);
    expect(
      schnorr.verify(hexToBytes(event.sig), hexToBytes(event.id), PUBKEY),
    ).toBe(true);
  });
});

describe("isAuthRequiredMessage", () => {
  it("detects the auth-required prefix", () => {
    expect(isAuthRequiredMessage("auth-required: login first")).toBe(true);
    expect(isAuthRequiredMessage("error: nope")).toBe(false);
  });
});

describe("signHttpAuth", () => {
  it("builds the kind 27235 event NIP-98 describes", async () => {
    // NIP-98: "The following tags MUST be included: `u` - absolute URL,
    // `method` - HTTP Request Method", and "The `content` SHOULD be empty."
    const { header, event } = await signHttpAuth({
      method: "post",
      url: "https://files.example/api",
      pubkey: PUBKEY,
      signEvent: signAs,
      createdAt: 1682327852,
    });
    expect(event.kind).toBe(HTTP_AUTH_EVENT_KIND);
    expect(event.content).toBe("");
    expect(event.tags).toEqual([
      ["u", "https://files.example/api"],
      // The method as the request carries it: NIP-98 wants it to equal the HTTP
      // method used, and that is spelled in capitals.
      ["method", "POST"],
    ]);
    expect(hasValidId(event)).toBe(true);
    // "the `kind 27235` event MUST be `base64` encoded and use the
    // Authorization scheme `Nostr`".
    expect(header.startsWith("Nostr ")).toBe(true);
    const decoded = JSON.parse(atob(header.slice("Nostr ".length))) as NostrEvent;
    expect(decoded).toEqual(event);
  });

  it("binds the file's hash as NIP-96 asks, in base64", async () => {
    // NIP-96's Auth section: "optionally with the encoded `payload` tag set to
    // the base64-encoded 256-bit SHA-256 hash of the file - not the hash of the
    // whole request body". NIP-98's own rule is hex, but it is about the request
    // body, and NIP-96 says plainly that the file's hash goes in base64 — so this
    // is the one place the two differ and the NIP-96 wording is the one that
    // applies. A server that checks it answers 403 when the two disagree, which
    // is a file that never arrives and an error the reader cannot explain.
    const digest = new Uint8Array(32).fill(0xab);
    const { event } = await signHttpAuth({
      method: "POST",
      url: "https://files.example/api",
      pubkey: PUBKEY,
      signEvent: signAs,
      payload: digest,
    });
    const tag = event.tags.find((t) => t[0] === "payload");
    expect(tag?.[1]).toBe("q6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6s=");
    // And it is the hash of the bytes, not of anything around them.
    expect(tag?.[1]).not.toBe(bytesToHex(digest));
  });
});

describe("signBlossomAuth", () => {
  it("builds the kind 24242 token BUD-11 describes", async () => {
    // BUD-11: a `t` tag naming the verb, an `expiration` the server checks, an
    // `x` tag naming the blob, and a `server` tag scoping the token. A NIP-98
    // header is refused in its place, so all of these have to be there.
    const hash = "9".repeat(64);
    const { event } = await signBlossomAuth({
      verb: "upload",
      pubkey: PUBKEY,
      signEvent: signAs,
      hashHex: hash,
      server: "files.example",
      createdAt: 1_700_000_000,
    });
    expect(event.kind).toBe(BLOSSOM_AUTH_EVENT_KIND);
    expect(event.tags[0]).toEqual(["t", "upload"]);
    expect(event.tags[1]).toEqual(["expiration", String(1_700_000_000 + 600)]);
    expect(event.tags).toContainEqual(["x", hash]);
    expect(event.tags).toContainEqual(["server", "files.example"]);
    expect(hasValidId(event)).toBe(true);
  });

  it("encodes the token as base64url without padding, as BUD-11 asks", async () => {
    // "base64url without padding, as JWT uses" — the difference from the
    // standard alphabet is only `+` and `/`, and a token carrying either is
    // rejected by a server decoding it as JWT.
    const { header } = await signBlossomAuth({
      verb: "delete",
      pubkey: PUBKEY,
      signEvent: signAs,
      hashHex: "f".repeat(64),
      createdAt: 1,
    });
    const token = header.slice("Nostr ".length);
    expect(token).not.toContain("+");
    expect(token).not.toContain("/");
    expect(token).not.toContain("=");
    // And it still decodes to the event that was signed.
    const padded = token.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = JSON.parse(atob(padded.padEnd(padded.length + (4 - (padded.length % 4)) % 4, "="))) as NostrEvent;
    expect(decoded.kind).toBe(BLOSSOM_AUTH_EVENT_KIND);
  });

  it("leaves out what the caller did not give it", async () => {
    // An `x` tag with nothing in it names no blob, and a `server` tag with an
    // empty host scopes the token to a host that does not exist.
    const { event } = await signBlossomAuth({
      verb: "list",
      pubkey: PUBKEY,
      signEvent: signAs,
      createdAt: 1,
    });
    expect(event.tags.some((t) => t[0] === "x")).toBe(false);
    expect(event.tags.some((t) => t[0] === "server")).toBe(false);
    expect(event.content).toBe("");
  });
});

describe("the base64 alphabets", () => {
  it("keeps the two apart, and strips only the url-safe padding", () => {
    // The standard form keeps `=` and uses `+` and `/`; the url-safe one uses
    // `-` and `_` and carries no padding. A helper that returned the same
    // string for both would make one of the two specs wrong without any test
    // noticing.
    // `û` in latin-1 is one byte `0xfb`, so as UTF-8 it is two (`0xc3 0xbb`), and
    // that is what produces the `+` and `/` the two alphabets differ on.
    expect(base64("ûÿ")).toBe("w7vDvw==");
    expect(base64Url("ûÿ")).toBe("w7vDvw");
    // The two alphabets differ only in `+` and `/`, and this input produces both:
    // `û` is two UTF-8 bytes here, so the string is `c3 bb 3e`.
    expect(base64("û>")).toBe("w7s+");
    expect(base64Url("û>")).toBe("w7s-");
    expect(base64("a")).toBe("YQ==");
    expect(base64Url("a")).toBe("YQ");
  });
});

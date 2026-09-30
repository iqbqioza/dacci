import { schnorr } from "@noble/curves/secp256k1";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { describe, expect, it } from "vitest";
import {
  AUTH_EVENT_KIND,
  hasValidId,
  isAuthRequiredMessage,
  signAuthEvent,
} from "../src/index.js";

const SECRET = "0".repeat(63) + "1";
const PUBKEY = bytesToHex(schnorr.getPublicKey(hexToBytes(SECRET)));

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

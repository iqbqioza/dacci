import { cbc } from "@noble/ciphers/aes.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/ciphers/utils.js";
import { base64 } from "@scure/base";
import { getSharedSecret } from "./keys";

const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder();

export function getSharedKey(secretKey: Uint8Array, publicKey: string): Uint8Array {
  return sha256(getSharedSecret(secretKey, publicKey));
}

export function encrypt(secretKey: Uint8Array, publicKey: string, plaintext: string): string {
  const key = getSharedKey(secretKey, publicKey);
  const iv = randomBytes(16);
  const ciphertext = cbc(key, iv).encrypt(utf8.encode(plaintext));
  const blob = new Uint8Array(iv.length + ciphertext.length);
  blob.set(iv, 0);
  blob.set(ciphertext, iv.length);
  return base64.encode(blob);
}

export function decrypt(secretKey: Uint8Array, publicKey: string, payload: string): string {
  const blob = base64.decode(payload);
  const iv = blob.slice(0, 16);
  const ciphertext = blob.slice(16);
  const plaintext = cbc(getSharedKey(secretKey, publicKey), iv).decrypt(ciphertext);
  return utf8Decoder.decode(plaintext);
}
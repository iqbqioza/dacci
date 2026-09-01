import { extract, expand } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hmac } from "@noble/hashes/hmac.js";
import { chacha20 } from "@noble/ciphers/chacha.js";
import { randomBytes, utf8ToBytes } from "@noble/ciphers/utils.js";
import { base64 } from "@scure/base";
import { getSharedSecret } from "./keys";

export const NIP44_VERSION = 2;
export const NIP44_INFO = "nip44-v2";
export const MAX_PLAINTEXT_SIZE = 4294967295;
export const EXTENDED_PREFIX_THRESHOLD = 65536;
export const MIN_PADDED_SIZE = 32;

const utf8 = new TextEncoder();

function hkdfExtract(ikm: Uint8Array, salt: string): Uint8Array {
  return extract(sha256, ikm, utf8.encode(salt));
}

function hkdfExpand(prk: Uint8Array, info: Uint8Array, length: number): Uint8Array {
  return expand(sha256, prk, info, length);
}

export function getConversationKey(secretKey: Uint8Array, publicKey: string): Uint8Array {
  const sharedX = getSharedSecret(secretKey, publicKey);
  return hkdfExtract(sharedX, NIP44_INFO);
}

function getMessageKeys(conversationKey: Uint8Array, nonce: Uint8Array): {
  chachaKey: Uint8Array;
  chachaNonce: Uint8Array;
  hmacKey: Uint8Array;
} {
  const keys = hkdfExpand(conversationKey, nonce, 76);
  return {
    chachaKey: keys.slice(0, 32),
    chachaNonce: keys.slice(32, 44),
    hmacKey: keys.slice(44, 76),
  };
}

export function calcPaddedLength(len: number): number {
  if (len <= 32) {
    return 32;
  }
  const nextPower = 1 << (Math.floor(Math.log2(len - 1)) + 1);
  const chunk = nextPower <= 256 ? 32 : nextPower / 8;
  return chunk * (Math.floor((len - 1) / chunk) + 1);
}

export function pad(plaintext: Uint8Array): Uint8Array {
  const len = plaintext.length;
  const prefixLen = len < EXTENDED_PREFIX_THRESHOLD ? 2 : 6;
  const padded = new Uint8Array(prefixLen + calcPaddedLength(len));
  const view = new DataView(padded.buffer);
  if (len < EXTENDED_PREFIX_THRESHOLD) {
    view.setUint16(0, len, false);
  } else {
    view.setUint16(0, 0, false);
    view.setUint32(2, len, false);
  }
  padded.set(plaintext, prefixLen);
  return padded;
}

export function unpad(padded: Uint8Array): Uint8Array {
  const view = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);
  const u16 = view.getUint16(0, false);
  let prefixLen = 2;
  let len = u16;
  if (u16 === 0) {
    prefixLen = 6;
    len = view.getUint32(2, false);
  }
  if (padded.length !== prefixLen + calcPaddedLength(len)) {
    throw new Error("invalid padded length");
  }
  for (let i = prefixLen + len; i < padded.length; i++) {
    if (padded[i] !== 0) {
      throw new Error("invalid padding");
    }
  }
  return padded.slice(prefixLen, prefixLen + len);
}

export function encrypt(secretKey: Uint8Array, publicKey: string, plaintext: string): string {
  const conversationKey = getConversationKey(secretKey, publicKey);
  return encryptWithConversationKey(conversationKey, plaintext);
}

export function encryptWithConversationKey(conversationKey: Uint8Array, plaintext: string): string {
  const data = utf8.encode(plaintext);
  if (data.length > MAX_PLAINTEXT_SIZE) {
    throw new Error("plaintext too large");
  }
  const nonce = randomBytes(32);
  const { chachaKey, chachaNonce, hmacKey } = getMessageKeys(conversationKey, nonce);
  const ciphertext = chacha20(chachaKey, chachaNonce, pad(data));
  const mac = hmac(sha256, hmacKey, concat(nonce, ciphertext));
  const payload = concat(new Uint8Array([NIP44_VERSION]), nonce, ciphertext, mac);
  return base64.encode(payload);
}

export function decrypt(secretKey: Uint8Array, publicKey: string, payload: string): string {
  const conversationKey = getConversationKey(secretKey, publicKey);
  return decryptWithConversationKey(conversationKey, payload);
}

export function decryptWithConversationKey(conversationKey: Uint8Array, payload: string): string {
  const data = base64.decode(payload);
  if (data.length < 99) {
    throw new Error("payload too short");
  }
  if (data[0] !== NIP44_VERSION) {
    throw new Error("unsupported payload version");
  }
  const nonce = data.slice(1, 33);
  const mac = data.slice(data.length - 32);
  const ciphertext = data.slice(33, data.length - 32);
  const { chachaKey, chachaNonce, hmacKey } = getMessageKeys(conversationKey, nonce);
  const expectedMac = hmac(sha256, hmacKey, concat(nonce, ciphertext));
  if (!constantTimeEqual(mac, expectedMac)) {
    throw new Error("invalid MAC");
  }
  const padded = chacha20(chachaKey, chachaNonce, ciphertext);
  return new TextDecoder().decode(unpad(padded));
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) {
    out.set(arr, offset);
    offset += arr.length;
  }
  return out;
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}
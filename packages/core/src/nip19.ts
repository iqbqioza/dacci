import { bech32 } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";

export const NSEC_PREFIX = "nsec";
export const NPUB_PREFIX = "npub";

export function decodeBech32(prefix: string, value: string): Uint8Array {
  const { prefix: hrp, words } = bech32.decode(value);
  if (hrp !== prefix) {
    throw new Error(`invalid ${prefix} prefix`);
  }
  return bech32.fromWords(words);
}

export function encodeBech32(prefix: string, data: Uint8Array): string {
  return bech32.encode(prefix, bech32.toWords(data));
}

export function encodeNsec(secretKey: Uint8Array): string {
  return encodeBech32(NSEC_PREFIX, secretKey);
}

export function decodeNsec(nsec: string): Uint8Array {
  const secretKey = decodeBech32(NSEC_PREFIX, nsec);
  if (secretKey.length !== 32) {
    throw new Error("invalid nsec length");
  }
  return secretKey;
}

export function encodeNpub(publicKey: string): string {
  const bytes = hexToBytes(publicKey);
  return encodeBech32(NPUB_PREFIX, bytes);
}

export function decodeNpub(npub: string): string {
  const publicKey = decodeBech32(NPUB_PREFIX, npub);
  if (publicKey.length !== 32) {
    throw new Error("invalid npub length");
  }
  return bytesToHex(publicKey);
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error("invalid hex length");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function isHex(str: string): boolean {
  return /^[0-9a-f]+$/i.test(str);
}

export function isValidSecretKey(secretKey: Uint8Array): boolean {
  return secp256k1.utils.isValidSecretKey(secretKey);
}

export function isValidPublicKey(publicKey: string): boolean {
  return isHex(publicKey) && secp256k1.utils.isValidPublicKey(hexToBytes(publicKey));
}
import { scrypt } from "@noble/hashes/scrypt.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/ciphers/utils.js";
import { gcm } from "@noble/ciphers/aes.js";
import { base64 } from "@scure/base";
import { bytesToHex, hexToBytes } from "./nip19";

export const VAULT_VERSION = 1;
export const SCRYPT_N = 2 ** 15;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
const GCM_NONCE_LENGTH = 12;

export interface StoredKey {
  id: string;
  name: string;
  npub: string;
  encrypted: string;
  createdAt: number;
}

export interface VaultData {
  version: number;
  salt: string;
  keyHash: string;
  activeKeyId: string | null;
  keys: StoredKey[];
}

export interface DecryptedKey {
  id: string;
  name: string;
  npub: string;
  secretKey: Uint8Array;
  createdAt: number;
}

export function createVault(passphrase: string): { vault: VaultData; masterKey: Uint8Array } {
  const salt = randomBytes(16);
  const masterKey = deriveMasterKey(passphrase, salt);
  const vault: VaultData = {
    version: VAULT_VERSION,
    salt: bytesToHex(salt),
    keyHash: bytesToHex(sha256(masterKey)),
    activeKeyId: null,
    keys: [],
  };
  return { vault, masterKey };
}

export function deriveMasterKey(passphrase: string, salt: Uint8Array): Uint8Array {
  return scrypt(new TextEncoder().encode(passphrase), salt, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    dkLen: 32,
  });
}

export function verifyPassphrase(vault: VaultData, passphrase: string): Uint8Array | null {
  const masterKey = deriveMasterKey(passphrase, hexToBytes(vault.salt));
  const keyHash = bytesToHex(sha256(masterKey));
  if (keyHash !== vault.keyHash) {
    return null;
  }
  return masterKey;
}

export function encryptSecretKey(masterKey: Uint8Array, secretKey: Uint8Array): string {
  const nonce = randomBytes(GCM_NONCE_LENGTH);
  const ciphertext = gcm(masterKey, nonce).encrypt(secretKey);
  const blob = new Uint8Array(nonce.length + ciphertext.length);
  blob.set(nonce, 0);
  blob.set(ciphertext, nonce.length);
  return base64.encode(blob);
}

export function decryptSecretKey(masterKey: Uint8Array, encrypted: string): Uint8Array {
  const blob = base64.decode(encrypted);
  const nonce = blob.slice(0, GCM_NONCE_LENGTH);
  const ciphertext = blob.slice(GCM_NONCE_LENGTH);
  return gcm(masterKey, nonce).decrypt(ciphertext);
}
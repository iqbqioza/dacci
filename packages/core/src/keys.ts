import { secp256k1, schnorr } from "@noble/curves/secp256k1.js";
import { bytesToNumberBE, numberToBytesBE } from "@noble/curves/utils.js";
import { bytesToHex, hexToBytes } from "./nip19";

export function generateSecretKey(): Uint8Array {
  return secp256k1.utils.randomSecretKey();
}

export function getPublicKey(secretKey: Uint8Array): string {
  return bytesToHex(schnorr.getPublicKey(secretKey));
}

export function getSharedSecret(secretKey: Uint8Array, publicKey: string): Uint8Array {
  const point = schnorr.utils.lift_x(bytesToNumberBE(hexToBytes(publicKey)));
  const shared = point.multiply(bytesToNumberBE(secretKey));
  return numberToBytesBE(shared.toAffine().x, 32);
}
import {
  decodeNsec,
  hasNip07Extension,
  Nip07Signer,
  NsecSigner,
  type Signer,
} from "dacci-nostr-signer";
import type { AuthSigner } from "dacci-nostr-ws";
import { createSignal } from "solid-js";
import { eachConnection } from "./nostr.js";
import { applyLoginFeed, applyLoginRelaySet, restoreDefaults } from "./relays.js";
import type { RelayQueryFn } from "./relays.js";

export type LoginMethod = "nip07" | "nsec";

const STORAGE_KEY = "dacci.auth";

const [pubkey, setPubkey] = createSignal<string | null>(null);
const [method, setMethod] = createSignal<LoginMethod | null>(null);
const [authError, setAuthError] = createSignal<string | null>(null);

let activeSigner: Signer | null = null;

function applySignerToConnections(signer: Signer | null): void {
  const adapter: AuthSigner | undefined = signer
    ? (challenge, relayUrl) => signer.signAuth(challenge, relayUrl)
    : undefined;
  eachConnection((conn) => conn.setSigner(adapter));
}

export function useAuth() {
  return { pubkey, method, authError };
}

export function extensionAvailable(): boolean {
  return hasNip07Extension();
}

export async function loginWithExtension(): Promise<boolean> {
  setAuthError(null);
  try {
    const signer = new Nip07Signer();
    const key = await signer.getPublicKey();
    activeSigner = signer;
    setPubkey(key);
    setMethod("nip07");
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ pubkey: key, method: "nip07" }));
    applySignerToConnections(signer);
    await applyLoginRelaySet(key);
    await applyLoginFeed(key);
    return true;
  } catch (error) {
    setAuthError(
      error instanceof Error ? error.message : "拡張との通信に失敗しました",
    );
    return false;
  }
}

/**
 * Log in with an nsec1 string or 64-char hex secret.
 * The secret stays in memory only and is cleared on logout.
 * Only the pubkey is persisted.
 */
export async function loginWithNsec(input: string): Promise<boolean> {
  setAuthError(null);
  const trimmed = input.trim();
  let secretHex: string | null = null;
  if (/^[0-9a-f]{64}$/i.test(trimmed)) {
    secretHex = trimmed.toLowerCase();
  } else {
    secretHex = decodeNsec(trimmed);
  }
  if (secretHex === null) {
    setAuthError("nsec1または64桁hexの秘密鍵を入力してください");
    return false;
  }
  try {
    const signer = new NsecSigner(secretHex);
    const key = await signer.getPublicKey();
    activeSigner = signer;
    setPubkey(key);
    setMethod("nsec");
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ pubkey: key, method: "nsec-session" }));
    applySignerToConnections(signer);
    await applyLoginRelaySet(key);
    await applyLoginFeed(key);
    return true;
  } catch (error) {
    setAuthError(
      error instanceof Error ? error.message : "秘密鍵が不正です",
    );
    return false;
  }
}

export function logout(): void {
  activeSigner = null;
  setPubkey(null);
  setMethod(null);
  setAuthError(null);
  localStorage.removeItem(STORAGE_KEY);
  applySignerToConnections(null);
  restoreDefaults();
}

export function getSigner(): Signer | null {
  return activeSigner;
}

async function establishSession(signer: Signer, key: string): Promise<void> {
  activeSigner = signer;
  setPubkey(key);
  applySignerToConnections(signer);
}

/**
 * Restore a persisted session after reload. NIP-07 logins restore
 * silently (the extension still holds the key). nsec sessions cannot
 * be restored by design (the secret was memory-only), so the stale
 * entry is dropped and the user logs in again.
 */
export async function restoreSession(deps: {
  queryFn?: RelayQueryFn;
} = {}): Promise<boolean> {
  let stored: unknown;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return false;
    stored = JSON.parse(raw);
  } catch {
    localStorage.removeItem(STORAGE_KEY);
    return false;
  }
  if (
    typeof stored !== "object" ||
    stored === null ||
    (stored as { method?: unknown }).method !== "nip07"
  ) {
    localStorage.removeItem(STORAGE_KEY);
    return false;
  }
  try {
    const signer = new Nip07Signer();
    const key = await signer.getPublicKey();
    await establishSession(signer, key);
    setMethod("nip07");
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ pubkey: key, method: "nip07" }),
    );
    await applyLoginRelaySet(key, deps.queryFn);
    await applyLoginFeed(key, deps.queryFn);
    return true;
  } catch {
    logout();
    return false;
  }
}

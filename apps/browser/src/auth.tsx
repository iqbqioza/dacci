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
import { applyLoginProfile, restoreDefaults } from "./relays.js";
import type { RelayQueryFn } from "./relays.js";

export type LoginMethod = "nip07" | "nsec";

const STORAGE_KEY = "dacci.auth";
// Session scope: survives a reload, dies with the tab. The nsec secret is
// never written to localStorage, so it cannot outlive the browser session.
const SECRET_KEY = "dacci.nsec";

const [pubkey, setPubkey] = createSignal<string | null>(null);
const [method, setMethod] = createSignal<LoginMethod | null>(null);
const [authError, setAuthError] = createSignal<string | null>(null);
// "restoring" until the startup restore has decided, so the UI never
// flashes the login form while the extension is still being injected.
const [restoring, setRestoring] = createSignal(true);

let activeSigner: Signer | null = null;

function applySignerToConnections(signer: Signer | null): void {
  const adapter: AuthSigner | undefined = signer
    ? (challenge, relayUrl) => signer.signAuth(challenge, relayUrl)
    : undefined;
  eachConnection((conn) => conn.setSigner(adapter));
}

export function useAuth() {
  return { pubkey, method, authError, restoring };
}

/**
 * NIP-07 extensions inject `window.nostr` asynchronously, so it is usually
 * absent right after a reload. Wait for it instead of concluding that the
 * session is gone.
 */
async function waitForExtension(timeoutMs: number): Promise<boolean> {
  if (hasNip07Extension()) return true;
  const deadline = Date.now() + timeoutMs;
  // Start at 20ms and back off: most extensions are there almost at once,
  // so the UI must not sit on the full budget.
  let wait = 20;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, wait));
    if (hasNip07Extension()) return true;
    wait = Math.min(wait * 2, 100);
  }
  return false;
}

/** The extension can also refuse while the vault is locked: retry briefly. */
async function pubKeyWithRetry(attempts: number): Promise<string | null> {
  let wait = 50;
  for (let i = 0; i < attempts; i++) {
    try {
      return await new Nip07Signer().getPublicKey();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, wait));
      wait = Math.min(wait * 2, 200);
    }
  }
  return null;
}

export function extensionAvailable(): boolean {
  return hasNip07Extension();
}

function sessionStore(): Storage | null {
  try {
    return (globalThis as { sessionStorage?: Storage }).sessionStorage ?? null;
  } catch {
    return null;
  }
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
    // The extension owns the key, so nothing secret is kept here.
    sessionStore()?.removeItem(SECRET_KEY);
    applySignerToConnections(signer);
    await applyLoginProfile(key);
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
    // Session-scoped so a reload keeps the login, but the secret never
    // leaves the tab and is never written to localStorage.
    sessionStore()?.setItem(SECRET_KEY, secretHex);
    applySignerToConnections(signer);
    await applyLoginProfile(key);
    return true;
  } catch (error) {
    setAuthError(
      error instanceof Error ? error.message : "秘密鍵が不正です",
    );
    return false;
  }
}

/**
 * Explicit logout: drops the session *and* the persisted profile, so the
 * app goes back to the default relay set and the global feed.
 */
export function logout(): void {
  clearSession();
  restoreDefaults();
}

/**
 * Drops only the session. Used when restoring on reload: a failure here
 * (extension missing, key locked) must not wipe the resolved relay set,
 * otherwise every reload would reset the profile.
 */
function clearSession(options: { keepStoredEntry?: boolean } = {}): void {
  activeSigner = null;
  setPubkey(null);
  setMethod(null);
  setAuthError(null);
  if (options.keepStoredEntry !== true) {
    localStorage.removeItem(STORAGE_KEY);
    sessionStore()?.removeItem(SECRET_KEY);
  }
  applySignerToConnections(null);
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
 * silently (the extension still holds the key); nsec logins restore from
 * sessionStorage, which survives a reload but not the tab.
 *
 * The persisted relay set and feed are left untouched in both cases: only
 * an explicit logout resets those.
 */
export async function restoreSession(deps: {
  queryFn?: RelayQueryFn;
} = {}): Promise<boolean> {
  try {
    return await restoreSessionInner(deps);
  } finally {
    setRestoring(false);
  }
}

async function restoreSessionInner(deps: {
  queryFn?: RelayQueryFn;
}): Promise<boolean> {
  let stored: unknown;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return false;
    stored = JSON.parse(raw);
  } catch {
    localStorage.removeItem(STORAGE_KEY);
    return false;
  }
  if (typeof stored !== "object" || stored === null) {
    localStorage.removeItem(STORAGE_KEY);
    return false;
  }
  const method = (stored as { method?: unknown }).method;

  // nsec: the secret lives in sessionStorage, so a reload can pick the
  // login back up without ever persisting it beyond the tab.
  if (method === "nsec-session") {
    const secret = sessionStore()?.getItem(SECRET_KEY) ?? null;
    if (secret === null) {
      localStorage.removeItem(STORAGE_KEY);
      return false;
    }
    try {
      const signer = new NsecSigner(secret);
      const key = await signer.getPublicKey();
      await establishSession(signer, key);
      setMethod("nsec");
      await applyLoginProfile(key, deps.queryFn);
      return true;
    } catch {
      clearSession();
      return false;
    }
  }

  if (method !== "nip07") {
    localStorage.removeItem(STORAGE_KEY);
    return false;
  }
  const signer = new Nip07Signer();
  const present = await waitForExtension(1500);
  const key = present ? await pubKeyWithRetry(3) : null;
  if (key === null) {
    // The extension never showed up or the vault is locked: keep the
    // stored entry so the next reload can retry, and keep the relay set.
    clearSession({ keepStoredEntry: true });
    return false;
  }
  await establishSession(signer, key);
  setMethod("nip07");
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ pubkey: key, method: "nip07" }),
  );
  await applyLoginProfile(key, deps.queryFn);
  return true;
}

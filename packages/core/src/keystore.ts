import type { VaultData, StoredKey } from "./vault";
import { createVault, verifyPassphrase, encryptSecretKey, decryptSecretKey } from "./vault";
import { generateSecretKey, getPublicKey } from "./keys";
import { decodeNsec, encodeNpub, encodeNsec, decodeNpub } from "./nip19";
import { signEvent } from "./event";
import type { EventTemplate, SignedEvent } from "./event";
import { encrypt as nip04Encrypt, decrypt as nip04Decrypt } from "./nip04";
import { encrypt as nip44Encrypt, decrypt as nip44Decrypt } from "./nip44";
import type { ExportedKey, PublicKeyInfo, VaultState } from "./messages";

export interface VaultStorage {
  getVault(): Promise<VaultData | null>;
  setVault(vault: VaultData): Promise<void>;
}

export interface SessionData {
  masterKey: Uint8Array;
  expiresAt: number | null;
}

export interface SessionStorage {
  load(): Promise<SessionData | null>;
  save(data: SessionData): Promise<void>;
  clear(): Promise<void>;
}

function keyToPublicInfo(key: StoredKey): PublicKeyInfo {
  return {
    id: key.id,
    name: key.name,
    npub: key.npub,
    createdAt: key.createdAt,
  };
}

export class Keystore {
  private vault: VaultData | null = null;
  private masterKey: Uint8Array | null = null;
  private secretKeys = new Map<string, Uint8Array>();
  private lockTimer: ReturnType<typeof setTimeout> | null = null;
  private panelOpen = false;

  constructor(
    private storage: VaultStorage,
    private sessionStorage: SessionStorage,
    private autoLockMinutes: number | null,
  ) {}

  async init(): Promise<void> {
    this.vault = await this.storage.getVault();
    const session = await this.sessionStorage.load();
    if (session && (session.expiresAt === null || session.expiresAt > Date.now())) {
      try {
        this.masterKey = session.masterKey;
        this.decryptAllKeys();
        this.scheduleAutoLock();
        return;
      } catch {
        this.masterKey = null;
        this.secretKeys.clear();
      }
    }
    if (session) {
      await this.sessionStorage.clear();
    }
  }

  setAutoLockMinutes(minutes: number | null): void {
    this.autoLockMinutes = minutes;
    if (this.status === "unlocked") {
      this.scheduleAutoLock();
      void this.saveSession();
    }
  }

  setPanelOpen(open: boolean): void {
    this.panelOpen = open;
    if (open) {
      this.clearAutoLock();
    } else if (this.status === "unlocked") {
      this.scheduleAutoLock();
      void this.saveSession();
    }
  }

  get status(): "uninitialized" | "locked" | "unlocked" {
    if (!this.vault) {
      return "uninitialized";
    }
    return this.masterKey ? "unlocked" : "locked";
  }

  get activeKeyId(): string | null {
    return this.vault?.activeKeyId ?? null;
  }

  getState(): VaultState {
    return {
      status: this.status,
      keys: this.vault?.keys.map(keyToPublicInfo) ?? [],
      activeKeyId: this.vault?.activeKeyId ?? null,
      pendingRequests: 0,
      confirmRequest: null,
    };
  }

  async setup(passphrase: string): Promise<void> {
    if (this.vault) {
      throw new Error("vault already initialized");
    }
    const { vault, masterKey } = createVault(passphrase);
    this.vault = vault;
    this.masterKey = masterKey;
    this.secretKeys.clear();
    await this.storage.setVault(vault);
    this.scheduleAutoLock();
    await this.saveSession();
  }

  async unlock(passphrase: string): Promise<void> {
    if (!this.vault) {
      throw new Error("vault not initialized");
    }
    const masterKey = verifyPassphrase(this.vault, passphrase);
    if (!masterKey) {
      throw new Error("wrong passphrase");
    }
    this.masterKey = masterKey;
    this.decryptAllKeys();
    this.scheduleAutoLock();
    await this.saveSession();
  }

  lock(): void {
    this.masterKey = null;
    this.secretKeys.clear();
    this.clearAutoLock();
    void this.sessionStorage.clear();
  }

  private decryptAllKeys(): void {
    this.secretKeys.clear();
    const masterKey = this.requireMasterKey();
    for (const key of this.requireVault().keys) {
      this.secretKeys.set(key.id, decryptSecretKey(masterKey, key.encrypted));
    }
  }

  private async saveSession(): Promise<void> {
    const masterKey = this.masterKey;
    if (!masterKey) {
      return;
    }
    const expiresAt =
      this.autoLockMinutes === null ? null : Date.now() + this.autoLockMinutes * 60_000;
    await this.sessionStorage.save({ masterKey, expiresAt });
  }

  async createKey(name?: string): Promise<PublicKeyInfo> {
    this.requireUnlocked();
    return this.addKey(generateSecretKey(), name);
  }

  async importKey(nsec: string, name?: string): Promise<PublicKeyInfo> {
    this.requireUnlocked();
    return this.addKey(decodeNsec(nsec), name);
  }

  async selectKey(keyId: string): Promise<void> {
    this.requireUnlocked();
    const vault = this.requireVault();
    if (!vault.keys.some((key) => key.id === keyId)) {
      throw new Error("key not found");
    }
    vault.activeKeyId = keyId;
    await this.storage.setVault(vault);
  }

  async renameKey(keyId: string, name: string): Promise<void> {
    this.requireUnlocked();
    const vault = this.requireVault();
    const key = vault.keys.find((entry) => entry.id === keyId);
    if (!key) {
      throw new Error("key not found");
    }
    key.name = name.trim() || key.name;
    await this.storage.setVault(vault);
  }

  exportKey(keyId: string): ExportedKey {
    this.requireUnlocked();
    const vault = this.requireVault();
    const stored = vault.keys.find((entry) => entry.id === keyId);
    const secretKey = stored ? this.secretKeys.get(stored.id) : undefined;
    if (!stored || !secretKey) {
      throw new Error("key not found");
    }
    return {
      id: stored.id,
      name: stored.name,
      npub: stored.npub,
      nsec: encodeNsec(secretKey),
    };
  }

  async deleteKey(keyId: string): Promise<void> {
    this.requireUnlocked();
    const vault = this.requireVault();
    const index = vault.keys.findIndex((entry) => entry.id === keyId);
    if (index === -1) {
      throw new Error("key not found");
    }
    vault.keys.splice(index, 1);
    this.secretKeys.delete(keyId);
    if (vault.activeKeyId === keyId) {
      vault.activeKeyId = vault.keys[0]?.id ?? null;
    }
    await this.storage.setVault(vault);
  }

  getPublicKey(): string {
    this.requireUnlocked();
    return this.getActiveKey().pubkey;
  }

  signEvent(template: EventTemplate): SignedEvent {
    this.requireUnlocked();
    return signEvent(template, this.getActiveKey().secretKey);
  }

  async nip04Encrypt(publicKey: string, plaintext: string): Promise<string> {
    this.requireUnlocked();
    return nip04Encrypt(this.getActiveKey().secretKey, publicKey, plaintext);
  }

  async nip04Decrypt(publicKey: string, payload: string): Promise<string> {
    this.requireUnlocked();
    return nip04Decrypt(this.getActiveKey().secretKey, publicKey, payload);
  }

  async nip44Encrypt(publicKey: string, plaintext: string): Promise<string> {
    this.requireUnlocked();
    return nip44Encrypt(this.getActiveKey().secretKey, publicKey, plaintext);
  }

  async nip44Decrypt(publicKey: string, payload: string): Promise<string> {
    this.requireUnlocked();
    return nip44Decrypt(this.getActiveKey().secretKey, publicKey, payload);
  }

  private async addKey(secretKey: Uint8Array, name?: string): Promise<PublicKeyInfo> {
    const vault = this.requireVault();
    const pubkey = getPublicKey(secretKey);
    const info: StoredKey = {
      id: crypto.randomUUID(),
      name: name?.trim() || `Key ${vault.keys.length + 1}`,
      npub: encodeNpub(pubkey),
      encrypted: encryptSecretKey(this.requireMasterKey(), secretKey),
      createdAt: Date.now(),
    };
    vault.keys.push(info);
    this.secretKeys.set(info.id, secretKey);
    if (!vault.activeKeyId) {
      vault.activeKeyId = info.id;
    }
    await this.storage.setVault(vault);
    return keyToPublicInfo(info);
  }

  private getActiveKey(): { pubkey: string; secretKey: Uint8Array } {
    const vault = this.requireVault();
    const activeId = vault.activeKeyId;
    const stored = activeId ? vault.keys.find((key) => key.id === activeId) : undefined;
    const secretKey = stored ? this.secretKeys.get(stored.id) : undefined;
    if (!stored || !secretKey) {
      throw new Error("no active key");
    }
    return { pubkey: decodeNpub(stored.npub), secretKey };
  }

  private requireUnlocked(): void {
    if (this.status !== "unlocked") {
      throw new Error("keystore is locked");
    }
  }

  private requireVault(): VaultData {
    if (!this.vault) {
      throw new Error("vault not initialized");
    }
    return this.vault;
  }

  private requireMasterKey(): Uint8Array {
    if (!this.masterKey) {
      throw new Error("keystore is locked");
    }
    return this.masterKey;
  }

  private scheduleAutoLock(): void {
    this.clearAutoLock();
    if (this.panelOpen || this.autoLockMinutes === null) {
      return;
    }
    this.lockTimer = setTimeout(() => {
      this.lock();
    }, this.autoLockMinutes * 60 * 1000);
  }

  private clearAutoLock(): void {
    if (this.lockTimer !== null) {
      clearTimeout(this.lockTimer);
      this.lockTimer = null;
    }
  }
}
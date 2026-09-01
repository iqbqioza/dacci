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

  constructor(
    private storage: VaultStorage,
    private autoLockHours: number,
  ) {}

  async init(): Promise<void> {
    this.vault = await this.storage.getVault();
  }

  get status(): "uninitialized" | "locked" | "unlocked" {
    if (!this.vault) {
      return "uninitialized";
    }
    return this.masterKey ? "unlocked" : "locked";
  }

  getState(): VaultState {
    return {
      status: this.status,
      keys: this.vault?.keys.map(keyToPublicInfo) ?? [],
      activeKeyId: this.vault?.activeKeyId ?? null,
      autoLockHours: this.autoLockHours,
      pendingRequests: 0,
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
    this.secretKeys.clear();
    for (const key of this.vault.keys) {
      this.secretKeys.set(key.id, decryptSecretKey(masterKey, key.encrypted));
    }
    this.scheduleAutoLock();
  }

  lock(): void {
    this.masterKey = null;
    this.secretKeys.clear();
    this.clearAutoLock();
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
    this.lockTimer = setTimeout(() => {
      this.lock();
    }, this.autoLockHours * 60 * 60 * 1000);
  }

  private clearAutoLock(): void {
    if (this.lockTimer !== null) {
      clearTimeout(this.lockTimer);
      this.lockTimer = null;
    }
  }
}
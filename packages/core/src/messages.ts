import type { EventTemplate } from "./event";

export interface PublicKeyInfo {
  id: string;
  name: string;
  npub: string;
  createdAt: number;
}

export interface VaultState {
  status: "uninitialized" | "locked" | "unlocked";
  keys: PublicKeyInfo[];
  activeKeyId: string | null;
  autoLockHours: number;
  pendingRequests: number;
}

export interface NostrRequest {
  type: "nostr:request";
  requestId: string;
  method: string;
  args: unknown[];
}

export type NostrResponse =
  | { type: "nostr:response"; requestId: string; ok: true; result: unknown }
  | { type: "nostr:response"; requestId: string; ok: false; error: string };

export interface OpenPanelMessage {
  type: "dacci:openPanel";
  reason?: "manual" | "unlock";
}

export interface ClosePanelMessage {
  type: "dacci:closePanel";
}

export type ContentMessage = OpenPanelMessage | ClosePanelMessage | NostrResponse;

export interface GetStateMessage {
  type: "vault:getState";
}

export interface SetupMessage {
  type: "vault:setup";
  passphrase: string;
}

export interface UnlockMessage {
  type: "vault:unlock";
  passphrase: string;
}

export interface LockMessage {
  type: "vault:lock";
}

export interface CreateKeyMessage {
  type: "vault:createKey";
  name?: string;
}

export interface ImportKeyMessage {
  type: "vault:importKey";
  nsec: string;
  name?: string;
}

export interface SelectKeyMessage {
  type: "vault:selectKey";
  keyId: string;
}

export interface RenameKeyMessage {
  type: "vault:renameKey";
  keyId: string;
  name: string;
}

export interface FlushPendingMessage {
  type: "vault:flushPending";
}

export interface ExportKeyMessage {
  type: "vault:exportKey";
  keyId: string;
}

export interface ExportedKey {
  id: string;
  name: string;
  npub: string;
  nsec: string;
}

export type PanelRequest =
  | GetStateMessage
  | SetupMessage
  | UnlockMessage
  | LockMessage
  | CreateKeyMessage
  | ImportKeyMessage
  | SelectKeyMessage
  | RenameKeyMessage
  | FlushPendingMessage
  | ExportKeyMessage;

export type PanelResponse =
  | { type: "vault:state"; state: VaultState }
  | { type: "vault:error"; error: string }
  | { type: "vault:unlocked"; state: VaultState }
  | { type: "vault:created"; key: PublicKeyInfo }
  | { type: "vault:imported"; key: PublicKeyInfo }
  | { type: "vault:exported"; key: ExportedKey };

export interface SignEventRequest {
  type: "nostr:request";
  requestId: string;
  method: "signEvent";
  args: [EventTemplate];
}

export function createRequestId(): string {
  return crypto.randomUUID();
}
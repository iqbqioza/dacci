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
  pendingRequests: number;
  confirmRequest: ConfirmRequestInfo | null;
}

export type ConfirmDecision = "allow" | "deny" | "alwaysAllow" | "alwaysDeny";

export interface ConfirmRequestInfo {
  site: string;
  kind: number;
  content: string;
  tags: string[][];
}

export interface ConfirmDecisionMessage {
  type: "vault:confirmDecision";
  decision: ConfirmDecision;
}

export interface SitePermissionInfo {
  siteKey: string;
  setting: "allow" | "deny";
}

export interface GetSitePermissionsMessage {
  type: "vault:getSitePermissions";
  keyId: string;
}

export interface DeleteSitePermissionMessage {
  type: "vault:deleteSitePermission";
  keyId: string;
  siteKey: string;
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
  reason?: "manual" | "unlock" | "confirm";
}

export interface ClosePanelMessage {
  type: "dacci:closePanel";
}

export interface PanelOpenMessage {
  type: "dacci:panelOpen";
}

export interface PanelCloseMessage {
  type: "dacci:panelClose";
}

export type ContentMessage = OpenPanelMessage | ClosePanelMessage | NostrResponse;

export interface AppSettings {
  autoLockMinutes: number | null;
}

export interface GetSettingsMessage {
  type: "vault:getSettings";
}

export interface SetSettingsMessage {
  type: "vault:setSettings";
  settings: AppSettings;
}

export interface ChangePassphraseMessage {
  type: "vault:changePassphrase";
  currentPassphrase: string;
  newPassphrase: string;
}

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

export interface DeleteKeyMessage {
  type: "vault:deleteKey";
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
  | ExportKeyMessage
  | DeleteKeyMessage
  | GetSettingsMessage
  | SetSettingsMessage
  | ChangePassphraseMessage
  | ConfirmDecisionMessage
  | GetSitePermissionsMessage
  | DeleteSitePermissionMessage;

export type PanelResponse =
  | { type: "vault:state"; state: VaultState }
  | { type: "vault:error"; error: string }
  | { type: "vault:unlocked"; state: VaultState }
  | { type: "vault:created"; key: PublicKeyInfo }
  | { type: "vault:imported"; key: PublicKeyInfo }
  | { type: "vault:exported"; key: ExportedKey }
  | { type: "vault:settings"; settings: AppSettings }
  | { type: "vault:sitePermissions"; permissions: SitePermissionInfo[] };

export interface SignEventRequest {
  type: "nostr:request";
  requestId: string;
  method: "signEvent";
  args: [EventTemplate];
}

export function createRequestId(): string {
  return crypto.randomUUID();
}
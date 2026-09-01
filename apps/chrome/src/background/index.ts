import {
  Keystore,
  type AppSettings,
  type NostrRequest,
  type NostrResponse,
  type PanelRequest,
  type PanelResponse,
  type SessionStorage,
  type VaultData,
  type VaultState,
} from "@dacci/core";
import { bytesToHex, hexToBytes } from "@dacci/core";

const STORAGE_KEY = "dacci:vault";
const SETTINGS_KEY = "dacci:settings";
const SITE_SETTINGS_KEY = "dacci:siteSettings";
const SESSION_KEY = "dacci:session";
const DEFAULT_SETTINGS: AppSettings = { theme: "system", autoLockMinutes: 1440 };

const sessionStorage: SessionStorage = {
  load: async () => {
    if (!chrome.storage.session) {
      return null;
    }
    const stored = await chrome.storage.session.get(SESSION_KEY);
    const data = stored[SESSION_KEY] as
      | { masterKey?: string; expiresAt?: number | null }
      | undefined;
    if (!data?.masterKey) {
      return null;
    }
    return {
      masterKey: hexToBytes(data.masterKey),
      expiresAt: data.expiresAt ?? null,
    };
  },
  save: async ({ masterKey, expiresAt }) => {
    if (!chrome.storage.session) {
      return;
    }
    await chrome.storage.session.set({
      [SESSION_KEY]: { masterKey: bytesToHex(masterKey), expiresAt },
    });
  },
  clear: async () => {
    if (!chrome.storage.session) {
      return;
    }
    await chrome.storage.session.remove(SESSION_KEY);
  },
};

const keystore = new Keystore(
  {
    getVault: async (): Promise<VaultData | null> => {
      const stored = await chrome.storage.local.get(STORAGE_KEY);
      return (stored[STORAGE_KEY] as VaultData | undefined) ?? null;
    },
    setVault: async (vault: VaultData): Promise<void> => {
      await chrome.storage.local.set({ [STORAGE_KEY]: vault });
    },
  },
  sessionStorage,
  DEFAULT_SETTINGS.autoLockMinutes,
);

let settings: AppSettings = DEFAULT_SETTINGS;
let siteSettings: Record<string, Record<string, "allow" | "deny">> = {};

const initPromise = (async () => {
  await keystore.init();
  const stored = await chrome.storage.local.get([SETTINGS_KEY, SITE_SETTINGS_KEY]);
  settings = { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] as Partial<AppSettings> | undefined) };
  siteSettings =
    (stored[SITE_SETTINGS_KEY] as Record<string, Record<string, "allow" | "deny">> | undefined) ?? {};
  keystore.setAutoLockMinutes(settings.autoLockMinutes);
  console.log(`Dacci background loaded (status: ${keystore.status})`);
})();

initPromise.catch((error) => {
  console.error("Dacci: failed to load vault", error);
});

type RequestPayload = Pick<NostrRequest, "requestId" | "method" | "args">;

interface PendingRequest extends RequestPayload {
  sendResponse: (response: NostrResponse) => void;
  site?: string;
  siteKey?: string;
  keyId?: string;
  tabId?: number;
}

const lockPendingRequests: PendingRequest[] = [];
const confirmPendingRequests: PendingRequest[] = [];

function getVaultState(): VaultState {
  const confirm = confirmPendingRequests[0];
  const event = confirm?.args[0] as
    | { kind: number; content: string; tags?: string[][] }
    | undefined;
  return {
    ...keystore.getState(),
    pendingRequests: lockPendingRequests.length + confirmPendingRequests.length,
    confirmRequest: confirm
      ? {
          site: confirm.site ?? "",
          kind: event?.kind ?? 0,
          content: event?.content ?? "",
          tags: event?.tags ?? [],
        }
      : null,
  };
}

function getSite(sender: chrome.runtime.MessageSender): string | null {
  if (!sender.url) {
    return null;
  }
  try {
    return new URL(sender.url).host;
  } catch {
    return null;
  }
}

async function notifyStateChanged(): Promise<void> {
  await chrome.runtime.sendMessage({ type: "dacci:stateChanged" }).catch(() => {});
}

chrome.action.onClicked.addListener((tab) => {
  if (tab.id == null) {
    return;
  }
  void toggleOrOpenPanel(tab.id);
});

async function toggleOrOpenPanel(tabId: number): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "dacci:togglePanel" });
  } catch {
    await ensurePanelInTab(tabId);
  }
}

async function ensurePanelInTab(tabId: number): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "dacci:openPanel" });
    return;
  } catch {
    // content script not present in this tab; inject it
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["assets/content.iife.js"],
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["nostr-bridge.js"],
      world: "MAIN",
    });
  } catch {
    // restricted page (e.g. chrome://): open the panel as a popup window
    console.log("Dacci: injection blocked, opening panel in a popup window");
    await chrome.windows
      .create({
        url: chrome.runtime.getURL("panel.html"),
        type: "popup",
        width: 400,
        height: 640,
      })
      .catch(() => {});
    return;
  }
  await chrome.tabs.sendMessage(tabId, { type: "dacci:openPanel" }).catch(() => {});
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "nostr:request") {
    void handleNostrRequest(message as NostrRequest, sender, sendResponse);
    return true;
  }
  if (message?.type === "dacci:panelOpen") {
    keystore.setPanelOpen(true);
    return undefined;
  }
  if (message?.type === "dacci:panelClose") {
    keystore.setPanelOpen(false);
    return undefined;
  }
  if (typeof message?.type === "string" && (message.type as string).startsWith("vault:")) {
    void handlePanelRequest(message as PanelRequest, sendResponse);
    return true;
  }
  return undefined;
});

async function handleNostrRequest(
  request: NostrRequest,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: NostrResponse) => void,
): Promise<void> {
  await initPromise;
  const site = getSite(sender);
  if (keystore.status !== "unlocked") {
    const entry: PendingRequest = { ...request, sendResponse };
    if (site) {
      entry.site = site;
    }
    lockPendingRequests.push(entry);
    if (sender.tab?.id != null) {
      await ensurePanelInTab(sender.tab.id);
    }
    return;
  }
  await maybeConfirmOrRespond(request, sendResponse, site, sender.tab?.id);
}

async function maybeConfirmOrRespond(
  request: RequestPayload,
  sendResponse: (response: NostrResponse) => void,
  site: string | null,
  tabId?: number,
): Promise<void> {
  if (request.method === "signEvent" && site) {
    const kind = (request.args[0] as { kind?: number } | undefined)?.kind;
    const siteKey = kind === undefined ? site : `${site}:${kind}`;
    const keyId = keystore.activeKeyId;
    const setting = keyId ? siteSettings[keyId]?.[siteKey] : undefined;
    if (setting === "deny") {
      sendResponse({
        type: "nostr:response",
        requestId: request.requestId,
        ok: false,
        error: "signing denied by site policy",
      });
      return;
    }
    if (setting !== "allow") {
      const entry: PendingRequest = { ...request, sendResponse, site, siteKey };
      if (keyId) {
        entry.keyId = keyId;
      }
      if (tabId !== undefined) {
        entry.tabId = tabId;
      }
      confirmPendingRequests.push(entry);
      await notifyStateChanged();
      if (tabId != null) {
        await ensurePanelInTab(tabId);
      }
      return;
    }
  }
  await respond(request, sendResponse);
}

async function executeMethod(method: string, args: unknown[]): Promise<unknown> {
  switch (method) {
    case "getPublicKey":
      return keystore.getPublicKey();
    case "signEvent":
      return keystore.signEvent(args[0] as never);
    case "getRelays":
      return {};
    case "nip04.encrypt":
      return keystore.nip04Encrypt(args[0] as string, args[1] as string);
    case "nip04.decrypt":
      return keystore.nip04Decrypt(args[0] as string, args[1] as string);
    case "nip44.encrypt":
      return keystore.nip44Encrypt(args[0] as string, args[1] as string);
    case "nip44.decrypt":
      return keystore.nip44Decrypt(args[0] as string, args[1] as string);
    default:
      throw new Error(`unknown method: ${method}`);
  }
}

async function respond(
  request: RequestPayload,
  sendResponse: (response: NostrResponse) => void,
): Promise<void> {
  try {
    const result = await executeMethod(request.method, request.args);
    sendResponse({
      type: "nostr:response",
      requestId: request.requestId,
      ok: true,
      result,
    });
  } catch (error) {
    sendResponse({
      type: "nostr:response",
      requestId: request.requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function flushPendingRequests(): void {
  while (lockPendingRequests.length > 0) {
    const request = lockPendingRequests.shift()!;
    void maybeConfirmOrRespond(request, request.sendResponse, request.site ?? null, request.tabId);
  }
}

function prepareConfirmRequests(): void {
  const remaining: PendingRequest[] = [];
  for (const request of lockPendingRequests) {
    if (request.method === "signEvent") {
      void maybeConfirmOrRespond(request, request.sendResponse, request.site ?? null, request.tabId);
    } else {
      remaining.push(request);
    }
  }
  lockPendingRequests.length = 0;
  lockPendingRequests.push(...remaining);
}

async function handlePanelRequest(
  message: PanelRequest,
  sendResponse: (response: PanelResponse) => void,
): Promise<void> {
  await initPromise;
  switch (message.type) {
    case "vault:getState": {
      sendResponse({ type: "vault:state", state: getVaultState() });
      return;
    }
    case "vault:setup": {
      try {
        await keystore.setup(message.passphrase);
        prepareConfirmRequests();
        sendResponse({ type: "vault:unlocked", state: getVaultState() });
      } catch (error) {
        sendResponse({ type: "vault:error", error: errorMessage(error) });
      }
      return;
    }
    case "vault:unlock": {
      try {
        await keystore.unlock(message.passphrase);
        prepareConfirmRequests();
        sendResponse({ type: "vault:unlocked", state: getVaultState() });
      } catch (error) {
        sendResponse({ type: "vault:error", error: errorMessage(error) });
      }
      return;
    }
    case "vault:flushPending": {
      flushPendingRequests();
      sendResponse({ type: "vault:state", state: getVaultState() });
      return;
    }
    case "vault:lock": {
      keystore.lock();
      sendResponse({ type: "vault:state", state: getVaultState() });
      return;
    }
    case "vault:createKey": {
      try {
        const key = await keystore.createKey(message.name);
        sendResponse({ type: "vault:created", key });
      } catch (error) {
        sendResponse({ type: "vault:error", error: errorMessage(error) });
      }
      return;
    }
    case "vault:importKey": {
      try {
        const key = await keystore.importKey(message.nsec, message.name);
        sendResponse({ type: "vault:imported", key });
      } catch (error) {
        sendResponse({ type: "vault:error", error: errorMessage(error) });
      }
      return;
    }
    case "vault:selectKey": {
      try {
        await keystore.selectKey(message.keyId);
        sendResponse({ type: "vault:state", state: getVaultState() });
      } catch (error) {
        sendResponse({ type: "vault:error", error: errorMessage(error) });
      }
      return;
    }
    case "vault:renameKey": {
      try {
        await keystore.renameKey(message.keyId, message.name);
        sendResponse({ type: "vault:state", state: getVaultState() });
      } catch (error) {
        sendResponse({ type: "vault:error", error: errorMessage(error) });
      }
      return;
    }
    case "vault:exportKey": {
      try {
        const key = keystore.exportKey(message.keyId);
        sendResponse({ type: "vault:exported", key });
      } catch (error) {
        sendResponse({ type: "vault:error", error: errorMessage(error) });
      }
      return;
    }
    case "vault:deleteKey": {
      try {
        await keystore.deleteKey(message.keyId);
        if (siteSettings[message.keyId]) {
          delete siteSettings[message.keyId];
          await chrome.storage.local.set({ [SITE_SETTINGS_KEY]: siteSettings });
        }
        sendResponse({ type: "vault:state", state: getVaultState() });
      } catch (error) {
        sendResponse({ type: "vault:error", error: errorMessage(error) });
      }
      return;
    }
    case "vault:getSettings": {
      sendResponse({ type: "vault:settings", settings });
      return;
    }
    case "vault:setSettings": {
      settings = message.settings;
      keystore.setAutoLockMinutes(settings.autoLockMinutes);
      await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
      sendResponse({ type: "vault:settings", settings });
      return;
    }
    case "vault:confirmDecision": {
      const entry = confirmPendingRequests.shift();
      if (!entry) {
        sendResponse({ type: "vault:state", state: getVaultState() });
        return;
      }
      const allow =
        message.decision === "allow" || message.decision === "alwaysAllow";
      if (message.decision === "alwaysAllow" || message.decision === "alwaysDeny") {
        const siteKey = entry.siteKey;
        const keyId = entry.keyId;
        if (siteKey && keyId) {
          const perKey = (siteSettings[keyId] ??= {});
          perKey[siteKey] = allow ? "allow" : "deny";
          await chrome.storage.local.set({ [SITE_SETTINGS_KEY]: siteSettings });
        }
      }
      if (allow) {
        await respond(entry, entry.sendResponse);
      } else {
        entry.sendResponse({
          type: "nostr:response",
          requestId: entry.requestId,
          ok: false,
          error: "signing denied by user",
        });
      }
      await notifyStateChanged();
      sendResponse({ type: "vault:state", state: getVaultState() });
      return;
    }
    case "vault:getSitePermissions": {
      const perKey = siteSettings[message.keyId] ?? {};
      const permissions = Object.entries(perKey).map(([siteKey, setting]) => ({
        siteKey,
        setting,
      }));
      sendResponse({ type: "vault:sitePermissions", permissions });
      return;
    }
    case "vault:deleteSitePermission": {
      const perKey = siteSettings[message.keyId];
      if (perKey) {
        delete perKey[message.siteKey];
        if (Object.keys(perKey).length === 0) {
          delete siteSettings[message.keyId];
        }
        await chrome.storage.local.set({ [SITE_SETTINGS_KEY]: siteSettings });
      }
      const updated = siteSettings[message.keyId] ?? {};
      sendResponse({
        type: "vault:sitePermissions",
        permissions: Object.entries(updated).map(([siteKey, setting]) => ({
          siteKey,
          setting,
        })),
      });
      return;
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
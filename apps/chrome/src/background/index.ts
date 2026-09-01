import {
  Keystore,
  type AppSettings,
  type NostrRequest,
  type NostrResponse,
  type PanelRequest,
  type PanelResponse,
  type VaultData,
  type VaultState,
} from "@dacci/core";

const STORAGE_KEY = "dacci:vault";
const SETTINGS_KEY = "dacci:settings";
const DEFAULT_SETTINGS: AppSettings = { theme: "system", autoLockMinutes: 1440 };

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
  DEFAULT_SETTINGS.autoLockMinutes,
);

let settings: AppSettings = DEFAULT_SETTINGS;

const initPromise = (async () => {
  await keystore.init();
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  settings = { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] as Partial<AppSettings> | undefined) };
  keystore.setAutoLockMinutes(settings.autoLockMinutes);
  console.log(`Dacci background loaded (status: ${keystore.status})`);
})();

initPromise.catch((error) => {
  console.error("Dacci: failed to load vault", error);
});

interface PendingRequest {
  requestId: string;
  method: string;
  args: unknown[];
  sendResponse: (response: NostrResponse) => void;
}

const pendingRequests: PendingRequest[] = [];

function getVaultState(): VaultState {
  return { ...keystore.getState(), pendingRequests: pendingRequests.length };
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
  if (keystore.status !== "unlocked") {
    pendingRequests.push({ ...request, sendResponse });
    if (sender.tab?.id != null) {
      await ensurePanelInTab(sender.tab.id);
    }
    return;
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
  request: Pick<NostrRequest, "requestId" | "method" | "args">,
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
  while (pendingRequests.length > 0) {
    const request = pendingRequests.shift()!;
    void respond(request, request.sendResponse);
  }
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
        sendResponse({ type: "vault:unlocked", state: getVaultState() });
      } catch (error) {
        sendResponse({ type: "vault:error", error: errorMessage(error) });
      }
      return;
    }
    case "vault:unlock": {
      try {
        await keystore.unlock(message.passphrase);
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
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
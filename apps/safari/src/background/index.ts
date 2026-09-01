import {
  Keystore,
  type NostrRequest,
  type NostrResponse,
  type PanelRequest,
  type PanelResponse,
  type VaultData,
} from "@dacci/core";

const STORAGE_KEY = "dacci:vault";
const AUTO_LOCK_HOURS = 24;

const keystore = new Keystore(
  {
    getVault: async (): Promise<VaultData | null> => {
      const stored = await browser.storage.local.get(STORAGE_KEY);
      return (stored[STORAGE_KEY] as VaultData | undefined) ?? null;
    },
    setVault: async (vault: VaultData): Promise<void> => {
      await browser.storage.local.set({ [STORAGE_KEY]: vault });
    },
  },
  AUTO_LOCK_HOURS,
);

await keystore.init();

interface PendingRequest {
  requestId: string;
  method: string;
  args: unknown[];
  sendResponse: (response: NostrResponse) => void;
}

const pendingRequests: PendingRequest[] = [];

browser.action.onClicked.addListener((tab) => {
  if (tab.id == null) {
    return;
  }
  void toggleOrOpenPanel(tab.id);
});

async function toggleOrOpenPanel(tabId: number): Promise<void> {
  try {
    await browser.tabs.sendMessage(tabId, { type: "dacci:togglePanel" });
  } catch {
    await ensurePanelInTab(tabId);
  }
}

async function ensurePanelInTab(tabId: number): Promise<void> {
  try {
    await browser.tabs.sendMessage(tabId, { type: "dacci:openPanel" });
    return;
  } catch {
    // content script not present in this tab; inject it
  }
  try {
    await browser.scripting.executeScript({
      target: { tabId },
      files: ["assets/content.iife.js"],
    });
  } catch {
    return;
  }
  await browser.tabs.sendMessage(tabId, { type: "dacci:openPanel" }).catch(() => {});
}

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "nostr:request") {
    void handleNostrRequest(message as NostrRequest, sender, sendResponse);
    return true;
  }
  if (typeof message?.type === "string" && (message.type as string).startsWith("vault:")) {
    void handlePanelRequest(message as PanelRequest, sendResponse);
    return true;
  }
  return undefined;
});

async function handleNostrRequest(
  request: NostrRequest,
  sender: browser.runtime.MessageSender,
  sendResponse: (response: NostrResponse) => void,
): Promise<void> {
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
  switch (message.type) {
    case "vault:getState": {
      sendResponse({ type: "vault:state", state: keystore.getState() });
      return;
    }
    case "vault:setup": {
      try {
        await keystore.setup(message.passphrase);
        flushPendingRequests();
        sendResponse({ type: "vault:unlocked", state: keystore.getState() });
      } catch (error) {
        sendResponse({ type: "vault:error", error: errorMessage(error) });
      }
      return;
    }
    case "vault:unlock": {
      try {
        await keystore.unlock(message.passphrase);
        flushPendingRequests();
        sendResponse({ type: "vault:unlocked", state: keystore.getState() });
      } catch (error) {
        sendResponse({ type: "vault:error", error: errorMessage(error) });
      }
      return;
    }
    case "vault:lock": {
      keystore.lock();
      sendResponse({ type: "vault:state", state: keystore.getState() });
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
        sendResponse({ type: "vault:state", state: keystore.getState() });
      } catch (error) {
        sendResponse({ type: "vault:error", error: errorMessage(error) });
      }
      return;
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
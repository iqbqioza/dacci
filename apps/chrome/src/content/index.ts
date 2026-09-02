import type { NostrResponse } from "@signr/core";

const PANEL_URL = chrome.runtime.getURL("panel.html");
const PANEL_WIDTH = 384;
const PANEL_MARGIN = 16;

let panelFrame: HTMLIFrameElement | null = null;

function createPanelFrame(reason?: string): HTMLIFrameElement {
  const frame = document.createElement("iframe");
  frame.src = reason ? `${PANEL_URL}?reason=${encodeURIComponent(reason)}` : PANEL_URL;
  frame.style.cssText = `
    position: fixed;
    top: ${PANEL_MARGIN}px;
    right: -${PANEL_WIDTH + PANEL_MARGIN}px;
    width: ${PANEL_WIDTH}px;
    height: ${PANEL_WIDTH}px;
    border: none;
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
    z-index: 2147483647;
    transition: right 0.3s ease-in-out;
    background: #fff;
  `;
  return frame;
}

function openPanel(reason?: string) {
  if (panelFrame) {
    panelFrame.style.right = `${PANEL_MARGIN}px`;
    return;
  }
  panelFrame = createPanelFrame(reason);
  document.documentElement.appendChild(panelFrame);
  void panelFrame.offsetWidth;
  requestAnimationFrame(() => {
    panelFrame!.style.right = `${PANEL_MARGIN}px`;
  });
  void chrome.runtime.sendMessage({ type: "signr:panelOpen" });
}

function closePanel() {
  if (!panelFrame) return;
  const frame = panelFrame;
  frame.style.right = `-${PANEL_WIDTH + PANEL_MARGIN}px`;
  panelFrame = null;
  void chrome.runtime.sendMessage({ type: "signr:panelClose" });
  window.setTimeout(() => frame.remove(), 300);
}

function togglePanel() {
  if (panelFrame) {
    closePanel();
  } else {
    openPanel();
  }
}

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (data?.type !== "nostr:request") return;
  void chrome.runtime.sendMessage(data).then(
    (response: NostrResponse) => {
      window.postMessage(response, "*");
    },
    (error: unknown) => {
      window.postMessage(
        {
          type: "nostr:response",
          requestId: data.requestId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
        "*",
      );
    },
  );
});

window.addEventListener("message", (event) => {
  if (event.source !== panelFrame?.contentWindow) return;
  if (event.data?.type === "signr:closePanel") {
    closePanel();
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "signr:togglePanel") {
    togglePanel();
  } else if (message?.type === "signr:openPanel") {
    openPanel(message.reason as string | undefined);
  } else if (message?.type === "signr:closePanel") {
    closePanel();
  }
});
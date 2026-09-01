import type { NostrResponse } from "@dacci/core";

const PANEL_URL = chrome.runtime.getURL("panel.html");
const PANEL_WIDTH = 384;
const PANEL_MARGIN = 16;

let panelFrame: HTMLIFrameElement | null = null;

function createPanelFrame(): HTMLIFrameElement {
  const frame = document.createElement("iframe");
  frame.src = PANEL_URL;
  frame.style.cssText = `
    position: fixed;
    top: ${PANEL_MARGIN}px;
    right: -${PANEL_WIDTH + PANEL_MARGIN}px;
    width: ${PANEL_WIDTH}px;
    height: calc(100% - ${PANEL_MARGIN * 2}px);
    border: none;
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
    z-index: 2147483647;
    transition: right 0.3s ease-in-out;
    background: #fff;
  `;
  return frame;
}

function openPanel() {
  if (panelFrame) {
    panelFrame.style.right = `${PANEL_MARGIN}px`;
    return;
  }
  panelFrame = createPanelFrame();
  document.documentElement.appendChild(panelFrame);
  void panelFrame.offsetWidth;
  requestAnimationFrame(() => {
    panelFrame!.style.right = `${PANEL_MARGIN}px`;
  });
}

function closePanel() {
  if (!panelFrame) return;
  const frame = panelFrame;
  frame.style.right = `-${PANEL_WIDTH + PANEL_MARGIN}px`;
  panelFrame = null;
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
  void chrome.runtime.sendMessage(data).then((response: NostrResponse) => {
    window.postMessage(response, "*");
  });
});

window.addEventListener("message", (event) => {
  if (event.source !== panelFrame?.contentWindow) return;
  if (event.data?.type === "dacci:closePanel") {
    closePanel();
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "dacci:togglePanel") {
    togglePanel();
  } else if (message?.type === "dacci:openPanel") {
    openPanel();
  } else if (message?.type === "dacci:closePanel") {
    closePanel();
  }
});
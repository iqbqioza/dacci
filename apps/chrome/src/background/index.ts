import { version } from "@dacci/core";

console.log(`Dacci background loaded (${version})`);

chrome.action.onClicked.addListener((tab) => {
  if (tab.id == null) {
    return;
  }
  void chrome.tabs.sendMessage(tab.id, { type: "dacci:togglePanel" }).catch(() => {});
});
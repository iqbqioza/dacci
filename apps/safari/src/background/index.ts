import { version } from "@dacci/core";

console.log(`Dacci Safari background loaded (${version})`);

browser.action.onClicked.addListener((tab) => {
  if (tab.id == null) {
    return;
  }
  void browser.tabs.sendMessage(tab.id, { type: "dacci:togglePanel" }).catch(() => {});
});
import type { PanelRequest, PanelResponse } from "@signr/core";

export function sendPanelRequest<T extends PanelResponse>(request: PanelRequest): Promise<T> {
  return chrome.runtime.sendMessage(request) as Promise<T>;
}
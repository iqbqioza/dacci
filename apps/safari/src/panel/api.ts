import type { PanelRequest, PanelResponse } from "@signr/core";

export function sendPanelRequest<T extends PanelResponse>(request: PanelRequest): Promise<T> {
  return browser.runtime.sendMessage(request) as Promise<T>;
}
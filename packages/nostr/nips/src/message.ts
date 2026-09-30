import type { Filter } from "./filter.js";
import type { NostrEvent } from "./event.js";

export type ClientMessage =
  | ["EVENT", NostrEvent]
  | ["REQ", string, ...Filter[]]
  | ["CLOSE", string]
  | ["AUTH", NostrEvent];

export type RelayMessage =
  | ["EVENT", string, NostrEvent]
  | ["OK", string, boolean, string]
  | ["EOSE", string]
  | ["CLOSED", string, string]
  | ["NOTICE", string]
  | ["AUTH", string];

export function isRelayMessage(value: unknown): value is RelayMessage {
  if (!Array.isArray(value) || value.length === 0) return false;
  const [type] = value as [string];
  return (
    type === "EVENT" ||
    type === "OK" ||
    type === "EOSE" ||
    type === "CLOSED" ||
    type === "NOTICE" ||
    type === "AUTH"
  );
}

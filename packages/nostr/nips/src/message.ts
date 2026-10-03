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

/**
 * Whether a parsed JSON value is a relay message. Checks shape as well as
 * the type word: a bare `["EVENT"]` used to satisfy this guard while promising
 * an event at index 2, so every direct consumer indexed `undefined`.
 *
 * The optional tails stay optional: NIP-01 leaves the `CLOSED` reason and the
 * `OK` message off whenever there is nothing to say, and relays do omit them.
 */
export function isRelayMessage(value: unknown): value is RelayMessage {
  if (!Array.isArray(value) || value.length === 0) return false;
  const [type] = value as [string];
  switch (type) {
    case "EVENT":
      return value.length === 3 && typeof value[1] === "string";
    case "OK":
      return (
        (value.length === 3 || value.length === 4) &&
        typeof value[1] === "string"
      );
    case "EOSE":
      return value.length === 2 && typeof value[1] === "string";
    case "CLOSED":
      return (
        (value.length === 2 || value.length === 3) &&
        typeof value[1] === "string"
      );
    case "NOTICE":
      return value.length === 2;
    case "AUTH":
      return value.length === 2;
    default:
      return false;
  }
}

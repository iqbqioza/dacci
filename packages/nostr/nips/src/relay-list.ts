import type { NostrEvent } from "./event.js";

/** NIP-65 relay list metadata kind. */
export const RELAY_LIST_KIND = 10002;

export interface RelayListEntry {
  url: string;
  read: boolean;
  write: boolean;
  /** NIP-66 display name, from an `n` tag on the same `r` tag. */
  name?: string;
  /** NIP-66 description, from a `d` tag on the same `r` tag. */
  description?: string;
}

/** Normalize a relay URL. Null when it is not a ws(s) URL. */
export function normalizeRelayUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!/^wss?:\/\/[^/\s]+(\/\S*)?$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Parse a NIP-65 relay list event.
 * Tags without a read marker (or with "read") are readable;
 * "write"-only tags are excluded from timeline reads.
 * Duplicates collapse to the first occurrence, keeping its metadata.
 */
export function parseRelayList(event: NostrEvent): RelayListEntry[] {
  if (event.kind !== RELAY_LIST_KIND) return [];
  const entries: RelayListEntry[] = [];
  const seen = new Map<string, number>();
  for (const tag of event.tags) {
    if (!Array.isArray(tag) || tag[0] !== "r") continue;
    const url = normalizeRelayUrl(tag[1]);
    if (url === null) continue;
    const marker = tag[2];
    const name = text(tag, "n");
    const description = text(tag, "d");
    const existing = seen.get(url);
    if (existing !== undefined) {
      // A later duplicate may carry the metadata the first one lacked.
      const previous = entries[existing];
      if (previous.name === undefined && name !== undefined) {
        previous.name = name;
      }
      if (previous.description === undefined && description !== undefined) {
        previous.description = description;
      }
      continue;
    }
    seen.set(url, entries.length);
    entries.push({
      url,
      read: marker === undefined || marker === "read",
      write: marker === undefined || marker === "write",
      ...(name === undefined ? {} : { name }),
      ...(description === undefined ? {} : { description }),
    });
  }
  return entries;
}

/** Value that follows the first `name` entry in a tag, when non-empty. */
function text(tag: string[], name: string): string | undefined {
  for (let index = 0; index < tag.length - 1; index++) {
    if (tag[index] !== name) continue;
    const value = tag[index + 1];
    return value === "" ? undefined : value;
  }
  return undefined;
}

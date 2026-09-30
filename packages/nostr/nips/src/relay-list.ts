import type { NostrEvent } from "./event.js";

/** NIP-65 relay list metadata kind. */
export const RELAY_LIST_KIND = 10002;

export interface RelayListEntry {
  url: string;
  read: boolean;
  write: boolean;
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
 * Duplicates collapse to the first occurrence.
 */
export function parseRelayList(event: NostrEvent): RelayListEntry[] {
  if (event.kind !== RELAY_LIST_KIND) return [];
  const entries: RelayListEntry[] = [];
  const seen = new Set<string>();
  for (const tag of event.tags) {
    if (!Array.isArray(tag) || tag[0] !== "r") continue;
    const url = normalizeRelayUrl(tag[1]);
    if (url === null || seen.has(url)) continue;
    seen.add(url);
    const marker = tag[2];
    entries.push({
      url,
      read: marker === undefined || marker === "read",
      write: marker === undefined || marker === "write",
    });
  }
  return entries;
}

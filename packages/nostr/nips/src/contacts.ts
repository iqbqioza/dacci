import { isHex64, type NostrEvent } from "./event.js";

/** NIP-02 follow list (contacts) kind. */
export const CONTACTS_KIND = 3;

/**
 * Parse a NIP-02 contacts event into followed pubkeys.
 * Only exact 64-char lowercase hex "p" tags count; duplicates collapse.
 */
export function parseContacts(event: NostrEvent): string[] {
  if (event.kind !== CONTACTS_KIND) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tag of event.tags) {
    if (!Array.isArray(tag) || tag[0] !== "p") continue;
    if (!isHex64(tag[1]) || seen.has(tag[1])) continue;
    seen.add(tag[1]);
    out.push(tag[1]);
  }
  return out;
}

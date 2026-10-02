import type { UnsignedEvent } from "./auth.js";
import type { NostrEvent } from "./event.js";

/**
 * NIP-01 metadata kind. It is replaceable, so an author has exactly one and
 * publishing it again replaces what was there: the whole profile is one event,
 * and every field in it has to be written back.
 */
export const METADATA_KIND = 0;

/**
 * The metadata an event carries, or an empty object when it carries none that
 * can be read. A profile is free-form JSON, so this is deliberately not a fixed
 * set of keys: a client that only knows six of them still has to be able to
 * republish the other forty without dropping them.
 */
export function parseMetadata(
  event: NostrEvent | null,
): Record<string, unknown> {
  if (event === null || event.kind !== METADATA_KIND) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(event.content);
  } catch {
    return {};
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  return raw as Record<string, unknown>;
}

/**
 * A value a profile field can hold. NIP-01's three fields are strings, and so
 * are most of NIP-24's, but `bot` is a boolean and `birthday` is an object, so
 * a profile is not all text.
 */
export type MetadataValue =
  | string
  | number
  | boolean
  | Record<string, unknown>
  | null;

/**
 * A profile with some fields changed and every other field left alone.
 *
 * A field set to an empty string or to null is removed rather than published
 * blank. NIP-01 has no way to say "this is empty but present", every client
 * treats `""` differently, and a reader who clears their bio means for it to be
 * gone, not for a blank line to appear under their name.
 */
export function withMetadata(
  existing: Record<string, unknown>,
  changes: Record<string, MetadataValue>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) {
      delete out[key];
      continue;
    }
    // Only text is trimmed and only text can be empty. `false` is a real answer
    // for `bot`, so a falsy value is not a removal; an empty object is, because
    // it says less than no field at all and no client reads anything out of it.
    if (typeof value === "string") {
      const text = value.trim();
      if (text === "") {
        delete out[key];
        continue;
      }
      out[key] = text;
      continue;
    }
    if (
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === 0
    ) {
      delete out[key];
      continue;
    }
    out[key] = value;
  }
  return out;
}

/**
 * NIP-24's birthday, as the object it is: a year, a month and a day, any of
 * which the NIP allows to be absent. An unreadable date is no date at all, so
 * the field is removed rather than published as something nobody can read.
 */
export function birthdayFrom(date: string): Record<string, number> | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  if (match === null) return null;
  const [year, month, day] = [match[1], match[2], match[3]].map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

/**
 * NIP-24's birthday object as a date input reads it. A birthday with no year is
 * not a date a form can hold, so it reads as empty rather than as a wrong one.
 */
export function birthdayTo(birthday: unknown): string {
  if (typeof birthday !== "object" || birthday === null || Array.isArray(birthday)) {
    return "";
  }
  const held = birthday as Record<string, unknown>;
  if (typeof held.year !== "number") return "";
  const pad = (key: string): string =>
    typeof held[key] === "number" ? String(held[key]).padStart(2, "0") : "";
  return `${held.year}-${pad("month")}-${pad("day")}`;
}

/**
 * NIP-01 metadata to publish. The keys are written in a fixed order so the
 * event is the same for the same profile, which keeps the id stable for anyone
 * comparing two of them.
 */
export function buildMetadata(input: {
  pubkey: string;
  metadata: Record<string, unknown>;
  createdAt: number;
}): UnsignedEvent {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(input.metadata).sort()) {
    sorted[key] = input.metadata[key];
  }
  return {
    pubkey: input.pubkey,
    created_at: input.createdAt,
    kind: METADATA_KIND,
    tags: [],
    content: JSON.stringify(sorted),
  };
}
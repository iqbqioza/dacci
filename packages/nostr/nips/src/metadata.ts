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

/** How long each month is, in order, and February where it is not a leap year. */
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * Whether a year, month and day name a date the calendar has.
 *
 * The range checks alone are not enough, and that was the whole of what was
 * checked. `1990-02-31`, `1990-04-31` and `1990-02-29` are all inside 1..12 and
 * 1..31, so all three were published as birthdays — dates no client can render,
 * written by the reader's own hand and then read back by everyone else.
 */
/**
 * The three parts as numbers, or null when they do not name a date the calendar
 * has.
 *
 * One gate for both directions, so they cannot disagree about what a birthday
 * is. It returns the parts rather than a yes, because "yes" leaves the caller
 * reading three `unknown`s back out of the object it was handed.
 */
function realDate(
  year: unknown,
  month: unknown,
  day: unknown,
): { year: number; month: number; day: number } | null {
  // A month written as a string and a month written as a fraction are both
  // refused here, rather than by a second check beside this one that could
  // disagree with it.
  if (typeof year !== "number" || typeof month !== "number" || typeof day !== "number") {
    return null;
  }
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }
  if (month < 1 || month > 12 || day < 1 || year < 0) return null;
  const last = month === 2 && isLeapYear(year) ? 29 : MONTH_DAYS[month - 1];
  if (day > last) return null;
  return { year, month, day };
}

/**
 * NIP-24's birthday, as the object it is: a year, a month and a day.
 *
 * All three are required here even though the NIP lets a client publish one
 * without a year, because the only thing that reads this is a date input and a
 * date input cannot hold a partial date. A year-less birthday therefore does not
 * come through this function — it stays in the published profile untouched
 * unless the reader deliberately replaces it, and `birthdayTo` says so by
 * answering empty. What this function will not do is invent the missing year.
 *
 * A date the calendar does not have is no date at all, so it is refused rather
 * than published. The range checks that used to be all of it let `1990-02-31`,
 * `1990-04-31` and `1990-02-29` through, so the reader could publish a birthday
 * no client can render.
 */
export function birthdayFrom(date: string): Record<string, number> | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  if (match === null) return null;
  const [year, month, day] = [match[1], match[2], match[3]].map(Number);
  return realDate(year, month, day);
}

/**
 * NIP-24's birthday object as a date input reads it. A birthday with no year is
 * not a date a form can hold, so it reads as empty rather than as a wrong one.
 *
 * Nothing is built out of parts that are not there. Padding whatever was found
 * produced `"2024--20"` for a month written as a string — a malformed date, which
 * a date input answers by showing nothing at all, so a profile that had a
 * birthday read as one that had none. A short year is padded rather than
 * dropped: the profile says 20, so `0020-05-06` is what it says.
 */
export function birthdayTo(birthday: unknown): string {
  if (typeof birthday !== "object" || birthday === null || Array.isArray(birthday)) {
    return "";
  }
  const held = birthday as Record<string, unknown>;
  const parts = realDate(held.year, held.month, held.day);
  // A date input has four digits for a year and no more.
  if (parts === null || parts.year > 9999) return "";
  const pad = (value: number, width: number): string =>
    String(value).padStart(width, "0");
  return `${pad(parts.year, 4)}-${pad(parts.month, 2)}-${pad(parts.day, 2)}`;
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
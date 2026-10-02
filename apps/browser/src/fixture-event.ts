import {
  computeEventId,
  pubkeyFor,
  signEvent,
  type NostrEvent,
} from "dacci-nostr-nips";

/**
 * Fixtures that are really signed.
 *
 * Every event a relay serves is checked for the author's own Schnorr signature
 * before a store acts on it, because a relay that forges a settings event
 * becomes the app's behaviour: a kind 10002 redirects every publish the reader
 * makes, a kind 3 decides whose posts the home feed shows, a kind 10063/10096
 * sends signed uploads to the server it names. A fixture with a made-up `sig` is
 * therefore not a simplification — it is a forgery, and a store asked to be
 * right about forgeries has to be handed real signatures to be right about
 * anything else.
 *
 * The secret is derived from a label so a fixture pubkey is stable across runs
 * and across files, and a test only has to name its author to sign as them.
 */
const secrets = new Map<string, string>();

/**
 * A 32-byte secret from a label.
 *
 * This is a fixture convenience, emphatically not key derivation: it repeats the
 * label's bytes to fill a secret, so every fixture key in the suite is public
 * and reproducible. That is the point — a test that needs an author's pubkey
 * should be able to write it down.
 */
function secretFor(label: string): string {
  const cached = secrets.get(label);
  if (cached !== undefined) return cached;
  // The length goes in front, which makes the seed injective: two labels of the
  // same length differ somewhere in it, and two of different lengths differ in
  // the first characters. Repeating the label alone was not — any label sharing
  // its first 18 characters with another got the same key, so two authors in one
  // file could quietly become the same person. A label too long for the field to
  // hold the whole of it is refused rather than truncated, because truncation is
  // what the collision was.
  const seed = `${label.length}:${label}:`;
  if (seed.length > 32) {
    throw new Error(
      `fixture label is too long to key a secret from: "${label}"`,
    );
  }
  const filled = seed.repeat(Math.ceil(32 / seed.length)).slice(0, 32);
  // The labels are ASCII by construction, so the code point is the byte.
  const secret = Array.from(filled, (c) =>
    c.charCodeAt(0).toString(16).padStart(2, "0"),
  ).join("");
  secrets.set(label, secret);
  return secret;
}

/** The pubkey a fixture author signs under, stable for a given label. */
export function fixturePubkey(label: string): string {
  return pubkeyFor(secretFor(label));
}

/** Every field of an event except the three that signing produces. */
export type UnsignedFixture = Omit<NostrEvent, "id" | "sig" | "pubkey">;

/**
 * An event `label` really signed, through the app's own `signEvent` so a fixture
 * is produced exactly as a publish is.
 *
 * `pubkey` is left to the signer deliberately: a fixture that named its own
 * author could not have been signed by anybody else, and half the point of these
 * fixtures is to be the author's own work.
 */
export function signAs(label: string, fields: UnsignedFixture): NostrEvent {
  const secret = secretFor(label);
  const pubkey = pubkeyFor(secret);
  return signEvent({ ...fields, pubkey }, secret);
}

/**
 * An event that claims to be `label`'s and is not.
 *
 * The id is the hash of the claimed author's own fields, so it is exactly what
 * `hasValidId` accepts and exactly what a relay could produce on purpose. This
 * is the shape the check exists for, so tests need it by name.
 */
export function forgedAs(label: string, fields: UnsignedFixture): NostrEvent {
  return { ...signAs(label, fields), sig: "0".repeat(128) };
}

/**
 * The same claim, carrying a signature someone else made.
 *
 * Worth having beside `forgedAs` because it is what a relay replaying an event
 * from another account looks like, rather than one inventing a signature. Both
 * are rejected by the same single check, so a test cannot tell them apart by the
 * outcome — the point is that neither is accepted.
 */
export function replayedAs(
  label: string,
  fields: UnsignedFixture,
): NostrEvent {
  const borrowed = signAs(`${label}-elsewhere`, {
    ...fields,
    content: "signed by somebody else",
  });
  return { ...signAs(label, fields), sig: borrowed.sig };
}

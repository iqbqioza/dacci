import { hasValidSignature, type NostrEvent } from "dacci-nostr-nips";

/**
 * True when the event really is one the named author wrote.
 *
 * A relay is not asked to vouch for anything. The only check every inbound
 * event passes through is `hasValidId`, which proves the id is the hash of the
 * author's own fields — and `pubkey` is one of those fields, so recomputing the
 * id after swapping the author still matches. That leaves any relay in the
 * reader's set able to serve an event claiming to be the reader's own, with an
 * id it computed itself.
 *
 * Which matters enormously, because these events are not read for their text.
 * They are *acted on*: a kind 10002 replaces the whole relay set, a kind 3
 * decides whose posts the home feed shows, a kind 10063/10096 redirects signed
 * Blossom uploads, and a kind 5 says a post is deleted. One hostile relay could
 * therefore take every publish the reader makes, signed, and hand it to the
 * attacker — and `switchTo` persists it, so it survives a reload.
 *
 * The check is cheap enough to be free here and expensive enough to rule out
 * everywhere else, so it belongs on the event a store *adopts*, not on the
 * stream. Verifying every event of a page would cost about 370× an id check
 * each, and a feed is not a place where an unsigned event is a security event:
 * a forged post is visibly a forged post, whereas a forged settings event
 * silently becomes the app's behaviour.
 */
export function isSignedBy(event: NostrEvent, pubkey: string): boolean {
  return event.pubkey === pubkey && hasValidSignature(event);
}

/**
 * Keeps only the events a named author signed, dropping the rest.
 *
 * A relay that answers with a forgery is answered like a relay that answered
 * with nothing: the caller falls back to what it already had. That is the safe
 * direction, because "the list was forged" and "no list was found" both mean
 * there is no reason to change anything the reader set deliberately.
 */
export function signedBy(
  events: NostrEvent[],
  pubkey: string,
): NostrEvent[] {
  return events.filter((event) => isSignedBy(event, pubkey));
}

/**
 * One relay's answer, with anything the named author did not sign taken out.
 *
 * Null means the relay said nothing usable, which is deliberately narrower than
 * "it sent nothing". A relay that answered with nothing *did* answer, and that
 * is the only thing that says a reader follows nobody or deleted nothing. A
 * relay that answered with nothing but forgeries has not answered at all, and
 * counting it as one would let a single hostile relay turn a forgery into the
 * opposite assertion — the reader's own history read as empty.
 */
export function authenticatedAnswer(
  events: NostrEvent[] | null,
  pubkey: string,
): NostrEvent[] | null {
  if (events === null) return null;
  const kept = signedBy(events, pubkey);
  return events.length > 0 && kept.length === 0 ? null : kept;
}

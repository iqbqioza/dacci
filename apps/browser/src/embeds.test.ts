import type { NostrEvent } from "dacci-nostr-nips";
import { computeEventId, encodeNote } from "dacci-nostr-nips";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NsecSigner } from "dacci-nostr-signer";
import { clearEventCache, rememberEvents } from "./event-cache.js";
import { markDeleted, resetDeleted } from "./deleted.js";
import { createEmbeds } from "./embeds.js";

/** A real key, so a fixture can carry a signature that actually verifies. */
const signer = new NsecSigner("11".repeat(32));
const AUTHOR = await signer.getPublicKey();
/**
 * Targets that are never resolved, so their ids are never checked. Anything a
 * relay answers — or a feed already holds — carries a derived id instead,
 * because the embed store checks that an answer's id is the hash of its own
 * fields before it matches the lookup.
 */
const MISSING = "b".repeat(64);
const ELSEWHERE = "c".repeat(64);

const link = (id: string): string => `nostr:${encodeNote(id)}`;

/**
 * A note whose id follows from its own fields and whose signature is its
 * author's, which is what a repost carrying the note inline must have: that
 * content never crossed a socket, so nothing has vouched for it. The id alone
 * is not enough — it is the hash of fields the author chose, `pubkey` among
 * them — so a note that borrows someone else's key and recomputes the id passes
 * it, and the card would be drawn under that person's name.
 */
async function inlineNote(content: string): Promise<NostrEvent> {
  return signer.signEvent({
    pubkey: AUTHOR,
    created_at: 100,
    kind: 1,
    tags: [["t", "nostr"]],
    content,
  });
}

function note(content: string): NostrEvent {
  const base = { pubkey: AUTHOR, created_at: 100, kind: 1, tags: [], content };
  return { ...base, id: computeEventId(base), sig: "s".repeat(128) };
}

/** A quote repost: the quoter's words, pointing at the note with q and e. */
function quoteRepost(targetId: string, text = "worth reading"): NostrEvent {
  return {
    id: "d".repeat(64),
    pubkey: "e".repeat(64),
    created_at: 200,
    kind: 6,
    tags: [
      ["q", targetId],
      ["e", targetId],
      ["p", AUTHOR],
    ],
    content: text,
    sig: "s".repeat(128),
  };
}

const tick = (ms = 0): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Flush the store queue at once, so tests do not wait on a timer. */
const FAST = { flushDelayMs: 1 };

afterEach(() => clearEventCache());

describe("embed wiring", () => {
  it("reports no embed for a post that quotes nothing", () => {
    const embeds = createEmbeds(async () => [], FAST);
    expect(embeds.useEmbed(note("plain"))).toEqual({ event: null });
  });

  it("shows nothing for a note a NIP-09 request has taken away", async () => {
    // Deleting a post has to take it out of every list, and the embed is a
    // list: the note travels inside a repost's own content, and a plain link to
    // a `nostr:note1…` has its text fetched. Otherwise the author deletes their
    // post and it goes on being drawn inside everything that referenced it.
    const gone = note("secret");
    markDeleted([gone.id]);
    try {
      const quoted = quoteRepost(gone.id);
      // The repost carries the note inline, so no query is needed to draw it.
      const secret = await inlineNote("secret");
      const withBody = { ...quoted, content: JSON.stringify(secret) };
      const embeds = createEmbeds(async () => [secret], FAST);
      embeds.requestEmbeds([quoted, withBody]);
      await tick(20);
      expect(embeds.useEmbed(quoted).event).toBeNull();
      expect(embeds.useEmbed(withBody).event).toBeNull();
      // And a note that merely links to it is not fetched either.
      const linker = note(`look ${link(gone.id)}`);
      const asked: string[][] = [];
      const watching = createEmbeds(async (ids) => {
        asked.push(ids);
        return [gone];
      }, FAST);
      watching.requestEmbeds([linker]);
      await tick(20);
      expect(asked).toEqual([]);
      expect(watching.useEmbed(linker).event).toBeNull();
    } finally {
      resetDeleted();
    }
  });

  it("shows the note again once it is not deleted", async () => {
    const live = note("live");
    const embeds = createEmbeds(async () => [live], FAST);
    markDeleted([live.id]);
    const linker = note(`look ${link(live.id)}`);
    embeds.requestEmbeds([linker]);
    await tick(20);
    expect(embeds.useEmbed(linker).event).toBeNull();
    // A deletion read back from a relay can also un-hide, so the check is read
    // live rather than baked in at request time. The id was never queued while
    // it was deleted, so the card asks again on the next render.
    resetDeleted();
    embeds.requestEmbeds([linker]);
    await tick(20);
    expect(embeds.useEmbed(linker).event?.id).toBe(live.id);
  });

  it("shows the note inline when the repost carries it as JSON", async () => {
    const embeds = createEmbeds(async () => [], FAST);
    const inner = await inlineNote("the original");
    const repost = {
      ...quoteRepost(inner.id),
      content: JSON.stringify(inner),
    };
    // No query is needed: NIP-18 puts the note in the content.
    expect(embeds.useEmbed(repost).event).toEqual(inner);
  });

  it("shows nothing for an inline note that does not match its id", async () => {
    // The outer repost is signed by whoever wrote it and passes every check,
    // so the card would otherwise draw a post that looks like the victim's own
    // and says whatever the attacker typed.
    const embeds = createEmbeds(async () => [], FAST);
    const victim = await inlineNote("the original");
    const repost = {
      ...quoteRepost(victim.id),
      content: JSON.stringify({ ...victim, content: "TRUST ME" }),
    };
    expect(embeds.useEmbed(repost).event).toBeNull();
  });

  it("reuses a note the feed already holds instead of querying", async () => {
    const query = vi.fn(async () => []);
    const embeds = createEmbeds(query, FAST);
    const inner = note("already loaded");
    rememberEvents([inner]);
    embeds.requestEmbeds([quoteRepost(inner.id)]);
    await tick(20);
    expect(query).not.toHaveBeenCalled();
    expect(embeds.useEmbed(quoteRepost(inner.id)).event).toEqual(inner);
  });

  it("resolves an unknown note over the network and then shows it", async () => {
    const inner = note("fetched from a relay");
    const query = vi.fn(async () => [inner]);
    const embeds = createEmbeds(query, FAST);
    const repost = quoteRepost(inner.id);

    embeds.requestEmbeds([repost]);
    // Before the reply lands the card shows a placeholder, not nothing.
    expect(embeds.useEmbedLoading(() => repost)()).toBe(true);
    await tick(30);
    expect(query).toHaveBeenCalledWith([inner.id]);
    expect(embeds.useEmbed(repost).event).toEqual(inner);
    expect(embeds.useEmbedLoading(() => repost)()).toBe(false);
  });

  it("batches a burst of reposts into one query", async () => {
    const query = vi.fn(async (_ids: string[]) => []);
    const embeds = createEmbeds(query, FAST);
    const first = note("first");
    const second = note("second");
    embeds.requestEmbeds([
      quoteRepost(first.id),
      { ...quoteRepost(second.id), id: "f".repeat(64) },
    ]);
    await tick(20);
    expect(query).toHaveBeenCalledTimes(1);
    const asked = query.mock.calls[0]?.[0] ?? [];
    expect([...asked].sort()).toEqual([first.id, second.id].sort());
  });

  it("stops asking once a note is resolved", async () => {
    const inner = note("resolved once");
    const query = vi.fn(async (_ids: string[]) => [inner]);
    const embeds = createEmbeds(query, FAST);
    const repost = quoteRepost(inner.id);
    embeds.requestEmbeds([repost]);
    await tick(30);
    embeds.requestEmbeds([repost]);
    await tick(30);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("stops reporting loading once no relay has the note", async () => {
    const query = vi.fn(async () => []);
    const embeds = createEmbeds(query, FAST);
    const repost = quoteRepost(MISSING);
    embeds.requestEmbeds([repost]);
    await tick(30);
    // A note nobody has renders nothing rather than spinning forever.
    expect(embeds.useEmbed(repost).event).toBeNull();
    expect(embeds.useEmbedLoading(() => repost)()).toBe(false);
  });

  it("shows nothing for a relay answer that rewrote the note", async () => {
    // The relay answered the requested id with different content. The id is
    // the hash of the fields, so this is not the note that was asked for but
    // another post wearing its id — and the card must not draw it as the
    // quoted note.
    const inner = note("the quoted note");
    const forged = { ...inner, content: "attacker words" };
    const query = vi.fn(async () => [forged]);
    const embeds = createEmbeds(query, FAST);
    const repost = quoteRepost(inner.id);
    embeds.requestEmbeds([repost]);
    await tick(30);
    expect(query).toHaveBeenCalledWith([inner.id]);
    expect(embeds.useEmbed(repost).event).toBeNull();
  });

  it("shows nothing for a repost once the cache is reset", async () => {
    const inner = note("before reset");
    const embeds = createEmbeds(async () => [inner], FAST);
    const repost = quoteRepost(inner.id);
    embeds.requestEmbeds([repost]);
    await tick(30);
    expect(embeds.useEmbed(repost).event).toEqual(inner);
    embeds.reset();
    expect(embeds.useEmbed(repost).event).toBeNull();
  });

  it("embeds the repost target of a plain repost with no q tag", async () => {
    const inner = note("reposted without q");
    const embeds = createEmbeds(async () => [inner], FAST);
    const repost: NostrEvent = {
      ...quoteRepost(inner.id, ""),
      tags: [["e", inner.id], ["p", AUTHOR]],
    };
    embeds.requestEmbeds([repost]);
    await tick(30);
    expect(embeds.useEmbed(repost).event).toEqual(inner);
  });
});

describe("quoting by link", () => {
  it("embeds a note the post links to without any NIP-18 tag", async () => {
    const inner = note("linked, not tagged");
    const query = vi.fn(async () => [inner]);
    const embeds = createEmbeds(query, FAST);
    const post = note(`read this ${link(inner.id)}`);

    embeds.requestEmbeds([post]);
    await tick(30);
    expect(query).toHaveBeenCalledWith([inner.id]);
    expect(embeds.useEmbed(post).event).toEqual(inner);
  });

  it("reuses a linked note the feed already holds instead of querying", async () => {
    const query = vi.fn(async () => []);
    const embeds = createEmbeds(query, FAST);
    const inner = note("already in the cache");
    rememberEvents([inner]);
    const post = note(link(inner.id));

    embeds.requestEmbeds([post]);
    await tick(20);
    expect(query).not.toHaveBeenCalled();
    expect(embeds.useEmbed(post).event).toEqual(inner);
  });

  it("keeps the q tag as the embed when a post both links and tags", async () => {
    const inner = note("the tagged note");
    const embeds = createEmbeds(async () => [inner], FAST);
    const post: NostrEvent = {
      ...note(`see also ${link(ELSEWHERE)}`),
      tags: [["q", inner.id]],
    };

    embeds.requestEmbeds([post]);
    await tick(30);
    expect(embeds.useEmbed(post).event).toEqual(inner);
  });

  it("shows no placeholder for a link no relay can resolve", async () => {
    const embeds = createEmbeds(async () => [], FAST);
    const post = note(link(MISSING));

    embeds.requestEmbeds([post]);
    await tick(30);
    expect(embeds.useEmbed(post)).toEqual({ event: null });
  });
});

describe("the inline note memo", () => {
  it("does not let a tampered post read another post's answer", async () => {
    // The memo is keyed by the event's id, which is only a sound key while the
    // id is the hash of the event's own fields. A post that keeps an id it no
    // longer matches would otherwise be handed whatever was cached for the id it
    // is claiming — so the answer to "what does this post embed" would come from
    // a different post entirely, and nothing about the second post would say so.
    const embeds = createEmbeds(async () => [], FAST);
    const inner = await inlineNote("the original");

    // A well-formed repost carrying the note inline, id and all.
    const base = quoteRepost(inner.id);
    const fields = { ...base, content: JSON.stringify(inner) };
    const honest: NostrEvent = { ...fields, id: computeEventId(fields) };
    expect(embeds.useEmbed(honest).event).toEqual(inner);

    // The same post with the note's words swapped, keeping the id it no longer
    // matches. Asked second, so an unsound memo would hand it the answer above.
    const tampered: NostrEvent = {
      ...honest,
      content: JSON.stringify({ ...inner, content: "TRUST ME" }),
    };
    expect(tampered.id).toBe(honest.id);
    expect(embeds.useEmbed(tampered).event).toBeNull();
  });


});

describe("the placeholder following the card it is on", () => {
  it("asks about the post the row is showing now, not the one it was created with", async () => {
    // The card list is a `<For>`, which reuses its rows positionally: a prepend
    // hands every mounted row a *different* post without remounting it. A
    // placeholder that read its post once, in the component body, would go on
    // asking about the post that row used to hold — a loading line under a card
    // whose own note is already here, and none at all under one still fetching.
    //
    // The two cards are in opposite states on purpose, so the answer says *which*
    // post was asked about rather than merely that something was.
    const query = vi.fn(async () => []);
    const embeds = createEmbeds(query, FAST);
    const quiet = quoteRepost(MISSING);
    const fetching = quoteRepost(ELSEWHERE);
    // Only the second card's note was ever asked for.
    embeds.requestEmbeds([fetching]);

    let showing = quiet;
    const loading = embeds.useEmbedLoading(() => showing);
    // Right answer, about the right post.
    expect(loading()).toBe(false);

    // The same row, now showing the card that is still fetching. If the post were
    // read once at creation this would still say false, and the reader would be
    // shown a card with nothing under it while its note loads.
    showing = fetching;
    expect(loading()).toBe(true);

    // And back again, so the accessor is following the row both ways.
    showing = quiet;
    expect(loading()).toBe(false);
  });
});

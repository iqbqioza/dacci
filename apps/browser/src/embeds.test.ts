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
const NOTE_ID = "b".repeat(64);
const OTHER_ID = "c".repeat(64);

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

function note(id: string, content: string): NostrEvent {
  return {
    id,
    pubkey: AUTHOR,
    created_at: 100,
    kind: 1,
    tags: [],
    content,
    sig: "s".repeat(128),
  };
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
    expect(embeds.useEmbed(note(NOTE_ID, "plain"))).toEqual({
      event: null,
      loading: false,
    });
  });

  it("shows nothing for a note a NIP-09 request has taken away", async () => {
    // Deleting a post has to take it out of every list, and the embed is a
    // list: the note travels inside a repost's own content, and a plain link to
    // a `nostr:note1…` has its text fetched. Otherwise the author deletes their
    // post and it goes on being drawn inside everything that referenced it.
    markDeleted([NOTE_ID]);
    try {
      const quoted = quoteRepost(NOTE_ID);
      // The repost carries the note inline, so no query is needed to draw it.
      const secret = await inlineNote("secret");
      const withBody = { ...quoted, content: JSON.stringify(secret) };
      const embeds = createEmbeds(async () => [secret], FAST);
      embeds.requestEmbeds([quoted, withBody]);
      await tick(20);
      expect(embeds.useEmbed(quoted).event).toBeNull();
      expect(embeds.useEmbed(withBody).event).toBeNull();
      // And a note that merely links to it is not fetched either.
      const linker = note(OTHER_ID, `look ${link(NOTE_ID)}`);
      const asked: string[][] = [];
      const watching = createEmbeds(async (ids) => {
        asked.push(ids);
        return [note(NOTE_ID, "secret")];
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
    const embeds = createEmbeds(async () => [note(NOTE_ID, "live")], FAST);
    markDeleted([NOTE_ID]);
    const linker = note(OTHER_ID, `look ${link(NOTE_ID)}`);
    embeds.requestEmbeds([linker]);
    await tick(20);
    expect(embeds.useEmbed(linker).event).toBeNull();
    // A deletion read back from a relay can also un-hide, so the check is read
    // live rather than baked in at request time. The id was never queued while
    // it was deleted, so the card asks again on the next render.
    resetDeleted();
    embeds.requestEmbeds([linker]);
    await tick(20);
    expect(embeds.useEmbed(linker).event?.id).toBe(NOTE_ID);
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
    const inner = note(NOTE_ID, "already loaded");
    rememberEvents([inner]);
    embeds.requestEmbeds([quoteRepost(NOTE_ID)]);
    await tick(20);
    expect(query).not.toHaveBeenCalled();
    expect(embeds.useEmbed(quoteRepost(NOTE_ID)).event).toEqual(inner);
  });

  it("resolves an unknown note over the network and then shows it", async () => {
    const inner = note(NOTE_ID, "fetched from a relay");
    const query = vi.fn(async () => [inner]);
    const embeds = createEmbeds(query, FAST);
    const repost = quoteRepost(NOTE_ID);

    embeds.requestEmbeds([repost]);
    // Before the reply lands the card shows a placeholder, not nothing.
    expect(embeds.useEmbed(repost).loading).toBe(true);
    await tick(30);
    expect(query).toHaveBeenCalledWith([NOTE_ID]);
    const after = embeds.useEmbed(repost);
    expect(after.event).toEqual(inner);
    expect(after.loading).toBe(false);
  });

  it("batches a burst of reposts into one query", async () => {
    const query = vi.fn(async (_ids: string[]) => []);
    const embeds = createEmbeds(query, FAST);
    embeds.requestEmbeds([
      quoteRepost(NOTE_ID),
      { ...quoteRepost(OTHER_ID), id: "f".repeat(64) },
    ]);
    await tick(20);
    expect(query).toHaveBeenCalledTimes(1);
    const asked = query.mock.calls[0]?.[0] ?? [];
    expect([...asked].sort()).toEqual([NOTE_ID, OTHER_ID].sort());
  });

  it("stops asking once a note is resolved", async () => {
    const inner = note(NOTE_ID, "resolved once");
    const query = vi.fn(async (_ids: string[]) => [inner]);
    const embeds = createEmbeds(query, FAST);
    const repost = quoteRepost(NOTE_ID);
    embeds.requestEmbeds([repost]);
    await tick(30);
    embeds.requestEmbeds([repost]);
    await tick(30);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("stops reporting loading once no relay has the note", async () => {
    const query = vi.fn(async () => []);
    const embeds = createEmbeds(query, FAST);
    const repost = quoteRepost(NOTE_ID);
    embeds.requestEmbeds([repost]);
    await tick(30);
    // A note nobody has renders nothing rather than spinning forever.
    const state = embeds.useEmbed(repost);
    expect(state.event).toBeNull();
    expect(state.loading).toBe(false);
  });

  it("shows nothing for a repost once the cache is reset", async () => {
    const inner = note(NOTE_ID, "before reset");
    const embeds = createEmbeds(async () => [inner], FAST);
    const repost = quoteRepost(NOTE_ID);
    embeds.requestEmbeds([repost]);
    await tick(30);
    expect(embeds.useEmbed(repost).event).toEqual(inner);
    embeds.reset();
    expect(embeds.useEmbed(repost).event).toBeNull();
  });

  it("embeds the repost target of a plain repost with no q tag", async () => {
    const inner = note(NOTE_ID, "reposted without q");
    const embeds = createEmbeds(async () => [inner], FAST);
    const repost: NostrEvent = {
      ...quoteRepost(NOTE_ID, ""),
      tags: [["e", NOTE_ID], ["p", AUTHOR]],
    };
    embeds.requestEmbeds([repost]);
    await tick(30);
    expect(embeds.useEmbed(repost).event).toEqual(inner);
  });
});

describe("quoting by link", () => {
  it("embeds a note the post links to without any NIP-18 tag", async () => {
    const inner = note(NOTE_ID, "linked, not tagged");
    const query = vi.fn(async () => [inner]);
    const embeds = createEmbeds(query, FAST);
    const post = note("f".repeat(64), `read this ${link(NOTE_ID)}`);

    embeds.requestEmbeds([post]);
    await tick(30);
    expect(query).toHaveBeenCalledWith([NOTE_ID]);
    expect(embeds.useEmbed(post).event).toEqual(inner);
  });

  it("reuses a linked note the feed already holds instead of querying", async () => {
    const query = vi.fn(async () => []);
    const embeds = createEmbeds(query, FAST);
    const inner = note(NOTE_ID, "already in the cache");
    rememberEvents([inner]);
    const post = note("f".repeat(64), link(NOTE_ID));

    embeds.requestEmbeds([post]);
    await tick(20);
    expect(query).not.toHaveBeenCalled();
    expect(embeds.useEmbed(post).event).toEqual(inner);
  });

  it("keeps the q tag as the embed when a post both links and tags", async () => {
    const inner = note(NOTE_ID, "the tagged note");
    const embeds = createEmbeds(async () => [inner], FAST);
    const post: NostrEvent = {
      ...note("f".repeat(64), `see also ${link(OTHER_ID)}`),
      tags: [["q", NOTE_ID]],
    };

    embeds.requestEmbeds([post]);
    await tick(30);
    expect(embeds.useEmbed(post).event).toEqual(inner);
  });

  it("shows no placeholder for a link no relay can resolve", async () => {
    const embeds = createEmbeds(async () => [], FAST);
    const post = note("f".repeat(64), link(NOTE_ID));

    embeds.requestEmbeds([post]);
    await tick(30);
    expect(embeds.useEmbed(post)).toEqual({ event: null, loading: false });
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

  it("answers the same post the same way however often it is asked", async () => {
    // The memo is a cost measure, not a rule, so what is worth pinning is that it
    // did not quietly become a different answer on the second and third reading.
    // A timing assertion is deliberately absent: a memo this large either saves
    // far more than any budget a test could set or the budget is machine-shaped,
    // and a test that only fails on slow hardware is not a test.
    const embeds = createEmbeds(async () => [], FAST);
    const inner = await inlineNote("the original");
    const base = quoteRepost(inner.id);
    const fields = { ...base, content: JSON.stringify(inner) };
    const repost: NostrEvent = { ...fields, id: computeEventId(fields) };

    for (let i = 0; i < 5; i++) {
      expect(embeds.useEmbed(repost).event).toEqual(inner);
    }
    // And a different post embedding nothing still gets nothing, after all that.
    expect(embeds.useEmbed(quoteRepost(OTHER_ID)).event).toBeNull();
  });
});

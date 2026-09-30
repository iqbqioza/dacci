import type { NostrEvent } from "dacci-nostr-nips";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearEventCache, rememberEvents } from "./event-cache.js";
import { createEmbeds } from "./embeds.js";

const AUTHOR = "a".repeat(64);
const NOTE_ID = "b".repeat(64);
const OTHER_ID = "c".repeat(64);

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

  it("shows the note inline when the repost carries it as JSON", () => {
    const embeds = createEmbeds(async () => [], FAST);
    const inner = note(NOTE_ID, "the original");
    const repost = {
      ...quoteRepost(NOTE_ID),
      content: JSON.stringify(inner),
    };
    // No query is needed: NIP-18 puts the note in the content.
    expect(embeds.useEmbed(repost).event).toEqual(inner);
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

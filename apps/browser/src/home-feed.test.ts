import { COMMENT_KIND, type NostrEvent } from "dacci-nostr-nips";
import { describe, expect, it } from "vitest";
import { postsForTab } from "./feed-tabs.jsx";
import { homePostsFor, selectHomeTab, useHomeFeed } from "./home-feed.js";

function note(
  id: string,
  tags: string[][] = [],
  kind = 1,
): NostrEvent {
  return {
    id,
    pubkey: "a".repeat(64),
    created_at: 1000,
    kind,
    tags,
    content: "x",
    sig: "s".repeat(128),
  };
}

const ME = "1".repeat(64);
const TOP = "a".repeat(64);
const REPLY = "b".repeat(64);
const COMMENT = "c".repeat(64);

const reply = note(REPLY, [["e", TOP, "", ME, "root"], ["p", ME]]);
const comment = note(COMMENT, [["I", "30023", ME, "my-article"]], COMMENT_KIND);
const top = note(TOP);

describe("postsForTab", () => {
  const all = [top, reply, comment];

  it("shows only standalone notes on the Notes tab", () => {
    expect(postsForTab(all, "notes")).toEqual([top]);
  });

  it("shows everything on the Replies and notes tab", () => {
    expect(postsForTab(all, "replies")).toEqual(all);
  });

  it("keeps comments out of Notes, since they belong to a conversation", () => {
    expect(postsForTab([comment], "notes")).toEqual([]);
  });

  it("never mutates the loaded list", () => {
    const list = [top, reply];
    postsForTab(list, "notes");
    expect(list).toEqual([top, reply]);
  });
});

describe("home feed tab", () => {
  it("starts on the Notes tab", () => {
    expect(useHomeFeed().tab()).toBe("notes");
  });

  it("remembers the selected tab", () => {
    selectHomeTab("replies");
    expect(useHomeFeed().tab()).toBe("replies");
    selectHomeTab("notes");
    expect(useHomeFeed().tab()).toBe("notes");
  });

  it("starts with no posts on either tab", () => {
    const feed = useHomeFeed();
    expect(feed.events()).toEqual([]);
    expect(feed.loadedCount()).toBe(0);
  });
});

describe("who a mute keeps out of the home feed", () => {
  const muted = (list: string[]) => (pubkey: string) => list.includes(pubkey);

  it("drops a muted author's posts and keeps everyone else's", () => {
    const events = [
      { ...top, pubkey: TOP },
      { ...top, id: REPLY, pubkey: "d".repeat(64) },
    ];
    expect(homePostsFor(events, "notes", muted(["a".repeat(64)]))).toEqual([
      { ...top, id: REPLY, pubkey: "d".repeat(64) },
    ]);
  });

  it("hides the muted author on both tabs", () => {
    // NIP-51 says feeds, and both tabs of the home feed are the feed.
    const events = [
      { ...top, pubkey: "d".repeat(64) },
      { ...reply, pubkey: "e".repeat(64) },
      { ...comment, pubkey: "d".repeat(64) },
    ];
    expect(homePostsFor(events, "replies", muted(["d".repeat(64)]))).toEqual([
      { ...reply, pubkey: "e".repeat(64) },
    ]);
  });

  it("keeps every post when nobody is muted", () => {
    expect(homePostsFor([top, reply], "replies", muted([]))).toEqual([top, reply]);
  });
});

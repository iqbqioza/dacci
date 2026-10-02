import { COMMENT_KIND, type NostrEvent } from "dacci-nostr-nips";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { postsForTab } from "./feed-tabs.jsx";
import {
  homePostsFor,
  noteBarVisibility,
  selectHomeTab,
  useHomeFeed,
} from "./home-feed.js";

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

const reply = note(REPLY, [["e", TOP, "", "root", ME], ["p", ME]]);
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

describe("the arrivals bar moving the list", () => {
  const BAR = 52;
  let scrolled: number[];

  beforeEach(() => {
    scrolled = [];
    // The store measures the bar and the window, and nothing else.
    vi.stubGlobal("window", {
      scrollY: 400,
      scrollBy: (opts: { top: number }) => scrolled.push(opts.top),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Registers a fresh bar, the way the component's ref does on creation. */
  function mountBar(): void {
    useHomeFeed().setBarRef({ offsetHeight: BAR } as HTMLButtonElement);
  }

  it("absorbs the bar arriving under a scrolled reader", () => {
    // The bar is inserted into the sticky header, so the list below it is pushed
    // down by its whole height. Left alone, the post the reader was reading jumps
    // on every arrival — which in an active timeline is every few seconds.
    mountBar();
    noteBarVisibility(true);
    expect(scrolled).toEqual([BAR]);
  });

  it("absorbs it again on the next arrival", () => {
    // The second arrival is the one that used to go unnoticed: the flag left set
    // from the first, and the bar is created afresh each time.
    mountBar();
    noteBarVisibility(true);
    noteBarVisibility(false);
    mountBar();
    noteBarVisibility(true);
    expect(scrolled).toEqual([BAR, BAR]);
  });

  it("does not scroll for a reader already at the top", () => {
    // At the top the bar is what should be visible, so nothing is corrected.
    vi.stubGlobal("window", {
      scrollY: 0,
      scrollBy: (opts: { top: number }) => scrolled.push(opts.top),
    });
    mountBar();
    noteBarVisibility(true);
    expect(scrolled).toEqual([]);
  });
});

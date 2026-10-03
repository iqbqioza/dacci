import { COMMENT_KIND, repostedAuthor, type NostrEvent } from "dacci-nostr-nips";
import { NsecSigner } from "dacci-nostr-signer";
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

describe("the mute, and what a repost carries", () => {
  const MUTED = "9".repeat(64);
  const bySomeone = (pubkey: string, tags: string[][], content = "x"): NostrEvent => ({
    id: "e".repeat(64),
    pubkey,
    created_at: 1000,
    kind: 1,
    tags,
    content,
    sig: "s".repeat(128),
  });

  it("drops a muted author's own post", () => {
    const isMuted = (pubkey: string): boolean => pubkey === MUTED;
    const mine = bySomeone("a".repeat(64), []);
    expect(homePostsFor([mine], "notes", isMuted)).toEqual([mine]);
    expect(homePostsFor([bySomeone(MUTED, [])], "notes", isMuted)).toEqual([]);
  });

  it("drops a repost of somebody the reader muted", () => {
    // The person who reposted is not the person who wrote it, and dropping only
    // the first meant every account on the reader's relay list could undo the
    // mute by reposting that person's notes.
    const isMuted = (pubkey: string): boolean => pubkey === MUTED;
    const by = "a".repeat(64);
    // NIP-18 puts the author's `p` tag on the repost, so that is who it says the
    // words are.
    const withAuthorTag = { ...bySomeone(by, [["p", MUTED]]), kind: 6 };
    expect(homePostsFor([withAuthorTag], "notes", isMuted)).toEqual([]);
    // The generic kind is no different.
    expect(
      homePostsFor([{ ...withAuthorTag, kind: 16 }], "notes", isMuted),
    ).toEqual([]);
    // And a repost by someone else of somebody *not* muted stays.
    const other = { ...bySomeone(by, [["p", ME]]), kind: 6 };
    expect(homePostsFor([other], "notes", isMuted)).toEqual([other]);
    // Both tabs, since a repost is in both.
    expect(homePostsFor([withAuthorTag], "replies", isMuted)).toEqual([]);
  });

  it("drops a repost whose note it carries is a muted author's", async () => {
    // The inline note names the author exactly, with no reliance on the `p`
    // tag another client wrote. It has to be genuinely signed: an inline note
    // whose id or signature does not check out is refused as a forgery, so a
    // fixture with a made-up one would be testing the refusal.
    const signer = new NsecSigner("11".repeat(32));
    const inner = await signer.signEvent({
      pubkey: await signer.getPublicKey(),
      created_at: 1000,
      kind: 1,
      tags: [],
      content: "words from a muted person",
    });
    const isMuted = (pubkey: string): boolean => pubkey === inner.pubkey;
    const repost = {
      ...bySomeone("a".repeat(64), [["p", "b".repeat(64)]], JSON.stringify(inner)),
      kind: 6,
    };
    expect(homePostsFor([repost], "notes", isMuted)).toEqual([]);
    // And the inline note is what said so: with a different `p` tag the same
    // repost is still dropped, because the note itself names its author.
    expect(repostedAuthor(repost)).toBe(inner.pubkey);
  });

  it("shows a repost that names nobody", () => {
    // Nothing in it says whose words it carries, and a list is filtered with
    // what it holds. Guessing here would hide posts over an author nobody said.
    const isMuted = (pubkey: string): boolean => pubkey === MUTED;
    const nameless = { ...bySomeone("a".repeat(64), []), kind: 6 };
    expect(repostedAuthor(nameless)).toBeNull();
    expect(homePostsFor([nameless], "notes", isMuted)).toEqual([nameless]);
  });

  it("is not a carried author for an ordinary post that mentions them", () => {
    // A `p` tag on a kind 1 is a mention, not a repost — and reading it as one
    // would drop every post that so much as named a muted person, which is not
    // what a mute was ever asked to do.
    const mention = bySomeone("a".repeat(64), [["p", MUTED]]);
    expect(repostedAuthor(mention)).toBeNull();
    const isMuted = (pubkey: string): boolean => pubkey === MUTED;
    expect(homePostsFor([mention], "replies", isMuted)).toEqual([mention]);
    // The same for a reply, which carries `p` tags for everyone it answers.
    const replyToThem = bySomeone("a".repeat(64), [["e", TOP], ["p", MUTED]]);
    expect(repostedAuthor(replyToThem)).toBeNull();
    expect(homePostsFor([replyToThem], "replies", isMuted)).toEqual([replyToThem]);
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

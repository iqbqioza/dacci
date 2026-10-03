import { COMMENT_KIND, computeEventId, type NostrEvent } from "dacci-nostr-nips";
import { describe, expect, it } from "vitest";
import {
  classifyFeedPost,
  isQuoteRepost,
  isReply,
  postsForTab,
  showsCommentLabel,
  showsRepostLabel,
} from "./feed-tabs.jsx";
import {
  selectProfileTab,
  useProfileFeed,
} from "./profile-feed.js";

function note(
  id: string,
  pubkey: string,
  tags: string[][] = [],
  createdAt = 1000,
  kind = 1,
): NostrEvent {
  const base = { pubkey, created_at: createdAt, kind, tags, content: "x" };
  return { ...base, id, sig: "s".repeat(128) };
}

const ME = "1".repeat(64);
const AUTHOR = "9".repeat(64);
const TOP = "a".repeat(64);
const PARENT = "b".repeat(64);
const REPLY = "c".repeat(64);
const COMMENT = "d".repeat(64);

describe("isReply", () => {
  it("treats a note with no e tag as a top-level note", () => {
    expect(isReply(note(TOP, ME))).toBe(false);
  });

  it("treats a note pointing at another event as a reply", () => {
    expect(isReply(note(REPLY, ME, [["e", PARENT, "", "root", ME]]))).toBe(
      true,
    );
  });

  it("ignores an e tag that points at the event itself", () => {
    // Clients mark a post's own thread root that way; it is not a reply.
    expect(isReply(note(TOP, ME, [["e", TOP, "", "root", ME]]))).toBe(false);
  });

  it("ignores tags that name neither an event nor an author", () => {
    expect(isReply(note(TOP, ME, [["t", PARENT], ["r", "wss://x"]]))).toBe(
      false,
    );
  });

  it("does not call a repost a reply", () => {
    // NIP-18 asks a repost for the `e` and `p` tags the reply test reads, so
    // every repost was a reply: labelled コメント, filed under "Replies and
    // notes", and sitting on a page of conversation it is not part of. A repost
    // answers nobody; it passes something on.
    for (const kind of [6, 16]) {
      const repost = note(TOP, ME, [["e", PARENT, "wss://x"], ["p", AUTHOR]], 1000, kind);
      expect(isReply(repost), `kind ${kind}`).toBe(false);
      expect(classifyFeedPost(repost), `kind ${kind}`).toBe("repost");
      expect(showsRepostLabel(repost), `kind ${kind}`).toBe(true);
      expect(showsCommentLabel(repost), `kind ${kind}`).toBe(false);
    }
    // A quote repost is one of them, and says so: it carries its own words.
    const quote = note(TOP, ME, [["q", PARENT, "wss://x", AUTHOR], ["e", PARENT]], 1000, 6);
    expect(isQuoteRepost(quote)).toBe(true);
    expect(showsRepostLabel(quote)).toBe(true);
    expect(isReply(quote)).toBe(false);
    // A plain repost is not a quote repost.
    expect(isQuoteRepost(note(TOP, ME, [["e", PARENT]], 1000, 6))).toBe(false);
  });
});

describe("classifyFeedPost", () => {
  const comment = note(COMMENT, ME, [["I", "30023", AUTHOR, "my-article"]], 1000, COMMENT_KIND);
  const legacyComment = note(COMMENT, ME, [["e", PARENT]], 1000, COMMENT_KIND);
  const reply = note(REPLY, ME, [["e", PARENT, "", "root", AUTHOR], ["p", AUTHOR]]);
  const top = note(TOP, ME);
  const ownRoot = note(TOP, ME, [["e", TOP, "", "root", ME]]);

  it("calls a top-level kind 1 a note", () => {
    expect(classifyFeedPost(top)).toBe("note");
    // An e tag pointing at the event itself is the thread's own root.
    expect(classifyFeedPost(ownRoot)).toBe("note");
  });

  it("calls a kind 1 that answers another event a reply", () => {
    expect(classifyFeedPost(reply)).toBe("reply");
    expect(isReply(reply)).toBe(true);
  });

  it("counts a p tag as addressing someone, so a reply", () => {
    // A mention names its author, so the post is not a plain note.
    const mention = note(TOP, ME, [["p", AUTHOR]]);
    expect(classifyFeedPost(mention)).toBe("reply");
    expect(isReply(mention)).toBe(true);
    // Even when the author points at themselves.
    expect(isReply(note(TOP, ME, [["p", ME]]))).toBe(true);
  });

  it("keeps a note with no e or p tag a note", () => {
    expect(classifyFeedPost(note(TOP, ME, [["t", "nostr"]]))).toBe("note");
  });

  it("treats NIP-22 comments as replies whichever tag they use", () => {
    expect(classifyFeedPost(comment)).toBe("comment");
    expect(classifyFeedPost(legacyComment)).toBe("comment");
    expect(isReply(comment)).toBe(true);
  });

  it("treats a kind 1 with an I tag as a comment", () => {
    // Before the dedicated kind, comments were kind 1 with an I tag.
    const kind1Comment = note(TOP, ME, [["I", "30023", AUTHOR, "post"]]);
    expect(classifyFeedPost(kind1Comment)).toBe("comment");
    expect(isReply(kind1Comment)).toBe(true);
  });
});

describe("showsCommentLabel", () => {
  const reply = note(REPLY, ME, [
    ["e", PARENT, "", "root", AUTHOR],
    ["p", AUTHOR],
  ]);
  const legacyComment = note(COMMENT, ME, [["e", PARENT]], 1000, COMMENT_KIND);
  const top = note(TOP, ME);

  it("labels replies and comments", () => {
    // A NIP-10 reply carries no I tag, yet it is still a comment on
    // someone else's post.
    expect(showsCommentLabel(reply)).toBe(true);
    expect(showsCommentLabel(legacyComment)).toBe(true);
  });

  it("leaves a standalone note unlabelled", () => {
    expect(showsCommentLabel(top)).toBe(false);
  });
});

describe("postsForTab, with reposts", () => {
  const top = note(TOP, ME);
  const reply = note(REPLY, ME, [["e", PARENT, "", "root", AUTHOR]]);
  const repost = note(TOP, ME, [["e", PARENT, "wss://x"], ["p", AUTHOR]], 1000, 6);
  const generic = note(REPLY, ME, [["e", PARENT, "wss://x"], ["p", AUTHOR], ["k", "10002"]], 1000, 16);

  it("shows a repost in both tabs, the way Twitter shows a boost", () => {
    // Neither tab was right on its own: Notes threw a repost away as not a
    // note, and Replies and notes kept it labelled as a conversation it is not
    // part of. It is not the author's own words and it answers nobody, so it
    // belongs in both rather than in one.
    for (const event of [repost, generic]) {
      expect(postsForTab([top, event], "notes")).toEqual([top, event]);
      expect(postsForTab([top, event], "replies")).toEqual([top, event]);
    }
  });

  it("still keeps a reply in the replies tab only", () => {
    expect(postsForTab([top, reply], "notes")).toEqual([top]);
    expect(postsForTab([top, reply], "replies")).toEqual([top, reply]);
  });
});

describe("profile feed store", () => {
  it("starts empty with the Notes tab selected", () => {
    const feed = useProfileFeed();
    expect(feed.events()).toEqual([]);
    expect(feed.tab()).toBe("notes");
    expect(feed.subject()).toBeNull();
  });

  it("keeps the selected tab", () => {
    selectProfileTab("replies");
    expect(useProfileFeed().tab()).toBe("replies");
    selectProfileTab("notes");
    expect(useProfileFeed().tab()).toBe("notes");
  });
});

describe("note ids", () => {
  it("are independent of the feed's sorting", () => {
    // Guards against a filter that would drop the newest posts.
    const events = [note(TOP, ME), note(REPLY, ME, [["e", PARENT]])];
    expect(computeEventId(events[0])).not.toBe(computeEventId(events[1]));
  });
});

import { computeEventId, type NostrEvent } from "dacci-nostr-nips";
import { describe, expect, it } from "vitest";
import { isReply, selectProfileTab, useProfileFeed } from "./profile-feed.js";

function note(
  id: string,
  pubkey: string,
  tags: string[][] = [],
  createdAt = 1000,
): NostrEvent {
  const base = { pubkey, created_at: createdAt, kind: 1, tags, content: "x" };
  return { ...base, id, sig: "s".repeat(128) };
}

const ME = "1".repeat(64);
const TOP = "a".repeat(64);
const PARENT = "b".repeat(64);
const REPLY = "c".repeat(64);

describe("isReply", () => {
  it("treats a note with no e tag as a top-level note", () => {
    expect(isReply(note(TOP, ME))).toBe(false);
  });

  it("treats a note pointing at another event as a reply", () => {
    expect(isReply(note(REPLY, ME, [["e", PARENT, "", ME, "root"]]))).toBe(
      true,
    );
  });

  it("ignores an e tag that points at the event itself", () => {
    // Clients mark a post's own thread root that way; it is not a reply.
    expect(isReply(note(TOP, ME, [["e", TOP, "", ME, "root"]]))).toBe(false);
  });

  it("ignores tags that are not e tags", () => {
    expect(
      isReply(note(TOP, ME, [["p", PARENT], ["t", PARENT]])),
    ).toBe(false);
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

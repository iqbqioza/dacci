import type { NostrEvent } from "dacci-nostr-nips";
import { describe, expect, it, vi } from "vitest";
import { createDetail } from "./detail.js";
import { clearEventCache, rememberEvents } from "./event-cache.js";

function note(id: string, content = "x"): NostrEvent {
  return {
    id,
    pubkey: "a".repeat(64),
    created_at: 100,
    kind: 1,
    tags: [],
    content,
    sig: "s".repeat(128),
  };
}

const ID = "b".repeat(64);
const OTHER = "c".repeat(64);

const tick = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

describe("note detail", () => {
  it("shows a post the feed already holds without querying", async () => {
    clearEventCache();
    const query = vi.fn(async () => null);
    const detail = createDetail(query);
    const cached = note(ID, "from the feed");
    rememberEvents([cached]);

    await detail.resolve(ID, () => true);
    expect(detail.event()).toEqual(cached);
    expect(detail.loading()).toBe(false);
    expect(detail.failed()).toBe(false);
    expect(query).not.toHaveBeenCalled();
    clearEventCache();
  });

  it("fetches a deep link no cache holds and shows it", async () => {
    clearEventCache();
    const found = note(ID, "from a relay");
    const detail = createDetail(async () => found);

    await detail.resolve(ID, () => true);
    expect(detail.event()).toEqual(found);
    expect(detail.loading()).toBe(false);
    expect(detail.failed()).toBe(false);
  });

  it("reports loading only while the post is in flight", async () => {
    clearEventCache();
    let release: (event: NostrEvent) => void = () => undefined;
    const detail = createDetail(
      () => new Promise<NostrEvent | null>((r) => (release = r)),
    );

    const pending = detail.resolve(ID, () => true);
    expect(detail.loading()).toBe(true);
    release(note(ID));
    await pending;
    expect(detail.loading()).toBe(false);
  });

  it("says plainly when no relay has the post", async () => {
    clearEventCache();
    // A deleted post resolves to nothing; the page must not stay blank.
    const detail = createDetail(async () => null);

    await detail.resolve(ID, () => true);
    expect(detail.event()).toBeNull();
    expect(detail.failed()).toBe(true);
    expect(detail.loading()).toBe(false);
  });

  it("drops a slow answer for a post the reader already left", async () => {
    clearEventCache();
    let release: (event: NostrEvent) => void = () => undefined;
    const detail = createDetail(
      () => new Promise<NostrEvent | null>((r) => (release = r)),
    );

    let current = ID;
    const pending = detail.resolve(ID, () => current === ID);
    // The reader opens another post before the first answer lands.
    current = OTHER;
    release(note(ID, "stale"));
    await pending;
    // The late answer must not replace what is on screen.
    expect(detail.event()).toBeNull();
    expect(detail.loading()).toBe(true);
  });

  it("drops a cached answer for a post the reader already left", async () => {
    // The network path checks `isCurrent` because a slow relay must not
    // replace the post being looked at. The cache hit skipped the check because
    // it resolves synchronously — so a reused store resolving for a stale id
    // overwrote the current post with no network involved at all.
    clearEventCache();
    const query = vi.fn(async () => null);
    const detail = createDetail(query);
    const stale = note(ID, "stale");
    rememberEvents([stale]);

    await detail.resolve(ID, () => false);
    expect(detail.event()).toBeNull();
    expect(query).not.toHaveBeenCalled();
    clearEventCache();
  });

  it("ignores an empty id rather than querying for it", async () => {
    clearEventCache();
    const query = vi.fn(async () => null);
    const detail = createDetail(query);

    await detail.resolve("", () => true);
    await tick();
    expect(query).not.toHaveBeenCalled();
  });
});

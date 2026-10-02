import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NostrEvent } from "dacci-nostr-nips";

const ME = "1".repeat(64);
const OTHER = "2".repeat(64);
const POST = "a".repeat(64);

function post(pubkey: string): NostrEvent {
  return {
    id: POST,
    pubkey,
    created_at: 1700000000,
    kind: 1,
    tags: [],
    content: "x",
    sig: "s".repeat(128),
  };
}

/** The events the relays accepted, so the request shape can be read back. */
let published: unknown[] = [];
/** Whether a publish is accepted, so the refusal path can be exercised. */
let accepted = true;
let signedInAs: string | null = ME;

/** Signs whatever template it is given, the way a vault would. */
function stubRelay(): void {
  vi.doMock("./nostr.js", () => ({
    getConnection: () => ({
      publish: async (event: unknown) => {
        published.push(event);
        return { accepted };
      },
    }),
  }));
  vi.doMock("./relays.js", () => ({
    // `readRelays` is here for NIP-18: the repost and quote tags name a relay the
    // quoted note can be fetched from, so the mock answers for the read side too.
    useRelays: () => ({
      writeRelays: () => ["wss://write.example"],
      readRelays: () => ["wss://read.example"],
    }),
    noteWriteResult: () => undefined,
  }));
  vi.doMock("./auth.jsx", () => ({
    useAuth: () => ({ pubkey: () => signedInAs }),
    getSigner: () => ({
      signEvent: async (template: unknown) => ({
        ...(template as object),
        id: "e".repeat(64),
        sig: "f".repeat(128),
      }),
    }),
  }));
}

beforeEach(async () => {
  vi.resetModules();
  published = [];
  accepted = true;
  signedInAs = ME;
  stubRelay();
});

afterEach(() => {
  vi.doUnmock("./auth.jsx");
  vi.doUnmock("./nostr.js");
  vi.doUnmock("./relays.js");
});

describe("deleteEvent", () => {
  it("asks for the post to be deleted, naming its kind", async () => {
    const compose = await import("./compose.js");
    expect(await compose.deleteEvent(post(ME))).toBe(true);
    // NIP-09 is a request, so the `k` tag is what lets a relay decide it may
    // drop the event rather than just record the request.
    expect(published[0]).toMatchObject({
      kind: 5,
      pubkey: ME,
      tags: [["k", "1"], ["e", POST]],
    });
  });

  it("takes the post off screen as soon as the request is out", async () => {
    const compose = await import("./compose.js");
    const deleted = await import("./deleted.js");
    expect(deleted.isDeleted(POST)).toBe(false);
    await compose.deleteEvent(post(ME));
    expect(deleted.isDeleted(POST)).toBe(true);
  });

  it("names the kind it is deleting, so a comment is not asked for as a note", async () => {
    const compose = await import("./compose.js");
    await compose.deleteEvent({ ...post(ME), kind: 1111 } as NostrEvent);
    expect(published[0]).toMatchObject({ tags: [["k", "1111"], ["e", POST]] });
  });

  it("leaves the post alone when no relay took the request", async () => {
    // A request nobody stored has changed nothing, so the post must stay.
    accepted = false;
    const compose = await import("./compose.js");
    const deleted = await import("./deleted.js");
    expect(await compose.deleteEvent(post(ME))).toBe(false);
    expect(deleted.isDeleted(POST)).toBe(false);
  });

  it("refuses to delete somebody else's post", async () => {
    // A deletion request naming another author's event is a claim, not a
    // deletion, and no relay acts on it.
    const compose = await import("./compose.js");
    expect(await compose.deleteEvent(post(OTHER))).toBe(false);
    expect(published).toHaveLength(0);
  });

  it("refuses while signed out", async () => {
    signedInAs = null;
    const compose = await import("./compose.js");
    expect(await compose.deleteEvent(post(ME))).toBe(false);
    expect(published).toHaveLength(0);
  });
});

describe("reposting and reacting", () => {
  /** A publish the test releases by hand, so a second press can land inside it. */
  function deferredRelay(): void {
    let release: (() => void) | null = null;
    vi.doMock("./nostr.js", () => ({
      getConnection: () => ({
        publish: async (event: unknown) => {
          published.push(event);
          await new Promise<void>((r) => {
            release = r;
          });
          return { accepted };
        },
      }),
    }));
    (globalThis as { __release?: () => void }).__release = () => release?.();
  }

  it("does not publish a second event when the reader presses twice", async () => {
    // The action bar's buttons stay live while a publish runs, and publishing is
    // a signing prompt plus up to five seconds of relay time. Two presses both
    // read "not done yet", so two kind 7 events go out; only the second id is
    // kept, and taking the reaction back deletes that one while the other stays
    // on the relays for good.
    deferredRelay();
    const release = () => (globalThis as { __release?: () => void }).__release?.();
    const compose = await import("./compose.js");
    const target = post(OTHER);

    const first = compose.toggleReaction(target);
    await Promise.resolve();
    // The second press lands while the first is still signing and publishing.
    expect(await compose.toggleReaction(target)).toBe(false);
    release?.();
    await first;

    expect(published.filter((e) => (e as { kind: number }).kind === 7)).toHaveLength(1);

    // The same for a repost.
    published = [];
    const reposted = compose.toggleRepost(target);
    await Promise.resolve();
    expect(await compose.toggleRepost(target)).toBe(false);
    release?.();
    await reposted;
    expect(published.filter((e) => (e as { kind: number }).kind === 6)).toHaveLength(1);
  });

  it("still allows a second press once the first has finished", async () => {
    // The guard is about the window while publishing, not about the post.
    const compose = await import("./compose.js");
    // The activity store learns who is signed in on login, and records the
    // action under that key; without it nothing is recorded and the second
    // press would see "not done yet" again.
    const actions = await import("./my-actions.js");
    actions.adoptMyActivity(ME);
    const target = post(OTHER);
    expect(await compose.toggleReaction(target)).toBe(true);
    expect(await compose.toggleReaction(target)).toBe(true);
    // Once, then a NIP-09 taking it back.
    expect(published.map((e) => (e as { kind: number }).kind)).toEqual([7, 5]);
  });
});

describe("broadcastEvent", () => {
  it("sends someone else's post as it stands, without signing it again", async () => {
    // The id and the signature are the author's. Re-signing would make a
    // different event, which is not the post any more.
    const compose = await import("./compose.js");
    const theirs = post(OTHER);
    expect(await compose.broadcastEvent(theirs)).toBe(true);
    expect(published).toEqual([theirs]);
    expect((published[0] as NostrEvent).id).toBe(POST);
    expect((published[0] as NostrEvent).sig).toBe("s".repeat(128));
  });

  it("needs no login, because the reader is not the author", async () => {
    signedInAs = null;
    const compose = await import("./compose.js");
    expect(await compose.broadcastEvent(post(OTHER))).toBe(true);
    expect(published).toHaveLength(1);
  });

  it("says so when no relay took it", async () => {
    accepted = false;
    const compose = await import("./compose.js");
    expect(await compose.broadcastEvent(post(OTHER))).toBe(false);
  });

  it("sends nothing when there is no relay to write to", async () => {
    vi.doMock("./relays.js", () => ({
      useRelays: () => ({ writeRelays: () => [], readRelays: () => [] }),
      noteWriteResult: () => undefined,
    }));
    const compose = await import("./compose.js");
    expect(await compose.broadcastEvent(post(OTHER))).toBe(false);
    expect(published).toHaveLength(0);
  });

  it("distinguishes nowhere-to-post from refused", async () => {
    // Both arrive as a count of zero, and only one of them is something the
    // reader can act on: "there is nowhere to post" points at Network, "they
    // refused it" does not. They used to be the same sentence, so a reader with
    // no write relay was told their note had been rejected by relays that were
    // never asked.
    const reported: string[] = [];
    vi.doMock("./nostr.js", () => ({
      getConnection: (url: string) => ({
        publish: async () => ({ accepted: false, fromRelay: true }),
      }),
    }));

    vi.doMock("./relays.js", () => ({
      useRelays: () => ({ writeRelays: () => [], readRelays: () => [] }),
      noteWriteResult: () => undefined,
    }));
    const nowhere = await import("./compose.js");
    await nowhere.publishEvent(post(OTHER), (reason) => reported.push(reason));
    expect(reported).toEqual(["no-relay"]);

    // And a relay that answered "no" is still a refusal.
    reported.length = 0;
    vi.doUnmock("./relays.js");
    vi.doMock("./relays.js", () => ({
      useRelays: () => ({
        writeRelays: () => ["wss://no.example"],
        readRelays: () => [],
      }),
      noteWriteResult: () => undefined,
    }));
    vi.resetModules();
    const refused = await import("./compose.js");
    await refused.publishEvent(post(OTHER), (reason) => reported.push(reason));
    expect(reported).toEqual(["rejected"]);
  });

  it("reports the outcome per relay, so the panel shows a real state", async () => {
    const noted: Array<[string, boolean]> = [];
    vi.doMock("./nostr.js", () => ({
      getConnection: (url: string) => ({
        publish: async () => ({ accepted: url.includes("ok") }),
      }),
    }));
    vi.doMock("./relays.js", () => ({
      useRelays: () => ({
        writeRelays: () => ["wss://ok.example", "wss://no.example"],
      }),
      noteWriteResult: (url: string, good: boolean) => noted.push([url, good]),
    }));
    const compose = await import("./compose.js");
    // One relay took it, so the action succeeded and both relays are recorded.
    expect(await compose.broadcastEvent(post(OTHER))).toBe(true);
    expect(noted).toEqual([
      ["wss://ok.example", true],
      ["wss://no.example", false],
    ]);
  });
});
describe("why a publish failed", () => {
  /** A signer that refuses, the way a dismissed NIP-07 prompt does. */
  function stubRefusingSigner(): void {
    vi.doMock("./auth.jsx", () => ({
      useAuth: () => ({ pubkey: () => signedInAs }),
      getSigner: () => ({
        signEvent: async () => {
          throw new Error("User rejected the request");
        },
      }),
    }));
  }

  it("does not tell the reader the relays refused when they refused nothing", async () => {
    // The distinction is the whole point. Dismissing the signing prompt means
    // nothing was ever sent, so "the relays refused" is a claim about a refusal
    // that did not happen — and it sends the reader off to check their relay
    // list instead of their signing prompt.
    vi.resetModules();
    stubRelay();
    stubRefusingSigner();
    const compose = await import("./compose.js");
    const seen: string[] = [];
    const sent = await compose.publishEvent(
      { pubkey: ME, created_at: 1, kind: 1, tags: [], content: "x" },
      (reason) => seen.push(compose.publishFailureText(reason, "投稿")),
    );
    expect(sent).toBeNull();
    expect(seen).toEqual(["署名をキャンセルしました"]);
  });

  it("returns the real reason from a reply instead of assuming a rejection", async () => {
    // `publishReply` reports why it failed through the reply form, and it used to
    // hand back a hardcoded "rejected" for every failure.
    vi.resetModules();
    stubRelay();
    stubRefusingSigner();
    const compose = await import("./compose.js");
    const result = await compose.publishReply(post(OTHER), "x");
    expect(result).toEqual({ failure: "cancelled" });
  });

  it("still says the action failed when the relays are what refused", async () => {
    // The action-specific wording is kept for the one reason it is true of.
    vi.resetModules();
    accepted = false;
    stubRelay();
    const compose = await import("./compose.js");
    expect(
      compose.publishFailureText("rejected", "フォロー"),
    ).toBe("フォローに失敗しました");
    expect(
      compose.publishFailureText("rejected", "ミュート"),
    ).toBe("ミュートに失敗しました");
  });

  it("prefers the reader's own setup over the action when it is the cause", async () => {
    // These two reasons are not about the action at all, and their existing
    // wording is what tells the reader what to do next.
    const compose = await import("./compose.js");
    expect(compose.publishFailureText("no-signer", "フォロー")).toBe(
      "ログインが必要です (Settings)",
    );
    expect(compose.publishFailureText("no-relay", "フォロー")).toBe(
      "書き込むリレーがありません (Network)",
    );
  });
});

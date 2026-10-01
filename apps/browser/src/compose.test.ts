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
    useRelays: () => ({ writeRelays: () => ["wss://write.example"] }),
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
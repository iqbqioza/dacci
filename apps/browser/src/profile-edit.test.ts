import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ME = "1".repeat(64);

let signedInAs: string | null = ME;
/** Whether a publish is accepted, so the refusal path can be exercised. */
let accepted = true;
/** Every event the relays took, which is what the assertions read back. */
let published: Array<{ kind: number; pubkey: string; content: string }> = [];

/** The profile the reader already has, as the store would report it. */
let held: Record<string, unknown> | null = null;
/** Whether the store has settled on that profile, as `resolved` reports it. */
let resolved = true;

async function freshStore() {
  vi.resetModules();
  return import("./profile-edit.js");
}

/** Parses the content of the one event that was published. */
function sentMetadata(): Record<string, unknown> {
  expect(published).toHaveLength(1);
  return JSON.parse(published[0].content) as Record<string, unknown>;
}

beforeEach(() => {
  vi.resetModules();
  signedInAs = ME;
  accepted = true;
  published = [];
  held = null;
  resolved = true;
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
  vi.doMock("./nostr.js", () => ({
    getConnection: () => ({
      publish: async (event: never) => {
        published.push(event);
        return { accepted };
      },
    }),
  }));
  vi.doMock("./relays.js", () => ({
    useRelays: () => ({ writeRelays: () => ["wss://write.example"] }),
    noteWriteResult: () => undefined,
  }));
  vi.doMock("./profile.js", () => ({
    useProfile: () => ({
      profile: held === null ? null : { pubkey: ME, metadata: held },
      loading: false,
      resolved,
    }),
    requestProfiles: () => undefined,
    applyProfile: () => undefined,
  }));
});

afterEach(() => {
  vi.doUnmock("./auth.jsx");
  vi.doUnmock("./nostr.js");
  vi.doUnmock("./profile.js");
  vi.doUnmock("./relays.js");
});

describe("saveProfile", () => {
  it("publishes kind 0 with the fields that changed", async () => {
    const store = await freshStore();
    expect(await store.saveProfile({ display_name: "たacky" })).toBe(true);
    expect(published[0]).toMatchObject({
      kind: 0,
      pubkey: ME,
      content: JSON.stringify({ display_name: "たacky" }),
    });
  });

  it("keeps fields the form has no box for", async () => {
    // NIP-01 replaces the whole profile, so publishing a name must not delete
    // what another client put there.
    held = { lud16: "me@wallet.example", name: "old" };
    const store = await freshStore();
    await store.saveProfile({ display_name: "たacky" });
    expect(sentMetadata()).toEqual({
      display_name: "たacky",
      lud16: "me@wallet.example",
      name: "old",
    });
  });

  it("removes a field cleared to nothing", async () => {
    held = { about: "old bio", name: "keep" };
    const store = await freshStore();
    await store.saveProfile({ about: "" });
    expect(sentMetadata()).toEqual({ name: "keep" });
  });

  it("publishes nothing when no relay took it, and says so", async () => {
    accepted = false;
    const store = await freshStore();
    store.openProfileEditor();
    expect(await store.saveProfile({ name: "x" })).toBe(false);
    expect(store.profileEditorError()).not.toBeNull();
    // The reader can try again, so the editor stays open and the button is not
    // left waiting.
    expect(store.profileEditorBusy()).toBe(false);
    expect(store.profileEditorOpen()).toBe(true);
  });

  it("closes once the profile is out", async () => {
    const store = await freshStore();
    store.openProfileEditor();
    await store.saveProfile({ name: "x" });
    expect(store.profileEditorOpen()).toBe(false);
  });

  it("refuses while signed out", async () => {
    signedInAs = null;
    const store = await freshStore();
    expect(await store.saveProfile({ name: "x" })).toBe(false);
    expect(published).toHaveLength(0);
  });

  it("refuses while the profile has not arrived, rather than publishing over it", async () => {
    // NIP-01 replaces the whole profile. A lookup that has not answered is not
    // an empty profile, so saving from here would wipe what is published.
    resolved = false;
    const store = await freshStore();
    store.openProfileEditor();
    expect(await store.saveProfile({ name: "x" })).toBe(false);
    expect(published).toHaveLength(0);
    expect(store.profileEditorError()).toBe("プロフィールを読み込んでいます");
  });

  it("lets a reader with no profile create one", async () => {
    // A resolved profile that is null means the author has none, which is not
    // the same as not knowing.
    resolved = true;
    held = null;
    const store = await freshStore();
    expect(await store.saveProfile({ name: "new" })).toBe(true);
    expect(sentMetadata()).toEqual({ name: "new" });
  });

  it("asks for the reader's own profile when it opens", async () => {
    const requested: string[][] = [];
    vi.doMock("./profile.js", () => ({
      useProfile: () => ({
        profile: null,
        loading: false,
        resolved: true,
      }),
      requestProfiles: (keys: string[]) => requested.push([...keys]),
      applyProfile: () => undefined,
    }));
    const store = await freshStore();
    store.openProfileEditor();
    expect(requested).toEqual([[ME]]);
  });
});

describe("the editor", () => {
  it("will not open for a reader who is not signed in", async () => {
    signedInAs = null;
    const store = await freshStore();
    expect(store.openProfileEditor()).toBe(false);
    expect(store.profileEditorOpen()).toBe(false);
  });

  it("opens and closes again", async () => {
    const store = await freshStore();
    expect(store.openProfileEditor()).toBe(true);
    expect(store.profileEditorOpen()).toBe(true);
    store.closeProfileEditor();
    expect(store.profileEditorOpen()).toBe(false);
  });

  it("offers the fields a profile is made of", async () => {
    const store = await freshStore();
    expect(store.PROFILE_FIELDS.map((field) => field.key)).toEqual([
      "display_name",
      "name",
      "about",
      "nip05",
      "website",
      "email",
      "location",
      "lud16",
    ]);
    // The images are separate, because a picture is a file to upload first.
    expect(store.PROFILE_IMAGES.map((field) => field.key)).toEqual([
      "picture",
      "banner",
    ]);
  });
});

describe("what a form's contents mean", () => {
  const store = async () => (await freshStore());

  it("sends only what the reader touched", async () => {
    const edits = await store();
    // Nothing typed: an untouched field must not be sent, because an empty
    // field is a removal.
    expect(edits.profileChanges({})).toEqual({});
    expect(edits.profileChanges({ about: "new" })).toEqual({ about: "new" });
  });

  it("reads a birthday as the object NIP-24 names", async () => {
    const edits = await store();
    expect(edits.profileChanges({}, "1990-02-03")).toEqual({
      birthday: { year: 1990, month: 2, day: 3 },
    });
  });

  it("removes the birthday when the date is cleared", async () => {
    const edits = await store();
    expect(edits.profileChanges({}, "")).toEqual({ birthday: null });
  });

  it("removes a birthday nobody could have been born on", async () => {
    const edits = await store();
    expect(edits.profileChanges({}, "1990-13-40")).toEqual({ birthday: null });
  });

  it("keeps bot false, which is an answer", async () => {
    const edits = await store();
    expect(edits.profileChanges({}, undefined, "false")).toEqual({ bot: false });
    expect(edits.profileChanges({}, undefined, "true")).toEqual({ bot: true });
  });

  it("publishes a birthday and a bot alongside the text", async () => {
    held = { name: "keep" };
    const edits = await store();
    edits.openProfileEditor();
    await edits.saveProfile(
      edits.profileChanges({ about: "hi" }, "1990-02-03", "true"),
    );
    expect(sentMetadata()).toEqual({
      about: "hi",
      birthday: { year: 1990, month: 2, day: 3 },
      bot: true,
      name: "keep",
    });
  });
});
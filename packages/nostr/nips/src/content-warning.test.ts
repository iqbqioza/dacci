import { describe, expect, it } from "vitest";
import {
  CONTENT_WARNING_KIND,
  contentWarning,
  hasContentWarning,
  type NostrEvent,
} from "./index.js";

function note(tags: string[][], content = "text"): NostrEvent {
  return {
    id: "a".repeat(64),
    pubkey: "b".repeat(64),
    created_at: 1700000000,
    kind: 1,
    tags,
    content,
    sig: "c".repeat(128),
  };
}

describe("contentWarning", () => {
  it("reads the reason from the tag", () => {
    expect(contentWarning(note([["content-warning", "性的内容"]]))).toBe("性的内容");
  });

  it("reports a warning that gave no reason as an empty one", () => {
    // The tag is there, so the post still asked to be approved; only the
    // reason is missing, which is a different thing from asking for nothing.
    expect(contentWarning(note([["content-warning"]]))).toBe("");
    expect(hasContentWarning(note([["content-warning"]]))).toBe(true);
  });

  it("reads the NIP-32 form the spec also allows", () => {
    const event = note([
      ["L", "content-warning"],
      ["l", "war", "content-warning"],
    ]);
    expect(contentWarning(event)).toBe("war");
  });

  it("reads a classified term whose namespace was never declared", () => {
    // The writer's omission of the `L` declaration is not a different word,
    // and missing the warning is the one outcome to avoid.
    expect(contentWarning(note([["l", "spoiler", "content-warning"]]))).toBe(
      "spoiler",
    );
  });

  it("ignores a classified term in another namespace", () => {
    const event = note([
      ["L", "social.nos.ontology"],
      ["l", "nud", "social.nos.ontology"],
    ]);
    expect(contentWarning(event)).toBeNull();
    expect(hasContentWarning(event)).toBe(false);
  });

  it("reports nothing for a post that asked for nothing", () => {
    const event = note([["t", "nostr"]]);
    expect(contentWarning(event)).toBeNull();
    expect(hasContentWarning(event)).toBe(false);
  });

  it("prefers the plain tag when a post carries both forms", () => {
    const event = note([
      ["l", "classified", "content-warning"],
      ["content-warning", "plain"],
    ]);
    expect(contentWarning(event)).toBe("plain");
  });

  it("names the kind NIP-36 defines for a client's own policy", () => {
    // It is published by clients, not read by them, but the constant belongs
    // with the tag so the NIP is represented whole.
    expect(CONTENT_WARNING_KIND).toBe(1984);
  });
});

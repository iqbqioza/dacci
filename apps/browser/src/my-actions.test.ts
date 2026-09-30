import { beforeEach, describe, expect, it } from "vitest";
import {
  activityFor,
  adoptMyActivity,
  clearReacted,
  hasDone,
  markReacted,
  markReposted,
  markReplied,
  myActivity,
} from "./my-actions.js";

const ME = "1".repeat(64);
const OTHER = "2".repeat(64);
const POST = "a".repeat(64);
const REACTION = "b".repeat(64);

class MemoryStorage {
  private readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
}

function installStorage(): MemoryStorage {
  const storage = new MemoryStorage();
  (globalThis as { localStorage?: Storage }).localStorage =
    storage as unknown as Storage;
  return storage;
}

describe("my actions", () => {
  beforeEach(() => {
    installStorage();
    adoptMyActivity(null);
  });

  it("starts empty and ignores marks while logged out", () => {
    markReacted(POST, REACTION);
    expect(myActivity().size).toBe(0);
  });

  it("records a reaction with the event id needed to undo it", () => {
    adoptMyActivity(ME);
    markReacted(POST, REACTION);
    expect(hasDone("react", POST)).toBe(true);
    expect(activityFor(POST).react).toBe(REACTION);
  });

  it("keeps actions on different posts apart", () => {
    adoptMyActivity(ME);
    markReacted(POST, REACTION);
    markReposted("c".repeat(64), "d".repeat(64));
    markReplied(POST);
    expect(hasDone("react", POST)).toBe(true);
    expect(hasDone("repost", POST)).toBe(false);
    expect(hasDone("replied", POST)).toBe(true);
    expect(hasDone("react", "c".repeat(64))).toBe(false);
  });

  it("survives a reload by way of storage", () => {
    adoptMyActivity(ME);
    markReacted(POST, REACTION);
    // A reload is a fresh module state reading the same storage.
    adoptMyActivity(null);
    adoptMyActivity(ME);
    expect(hasDone("react", POST)).toBe(true);
    expect(activityFor(POST).react).toBe(REACTION);
  });

  it("undoing a reaction clears it and is persisted", () => {
    adoptMyActivity(ME);
    markReacted(POST, REACTION);
    clearReacted(POST);
    expect(hasDone("react", POST)).toBe(false);
    // The post is dropped entirely once nothing is left on it.
    expect(myActivity().has(POST)).toBe(false);
    adoptMyActivity(null);
    adoptMyActivity(ME);
    expect(hasDone("react", POST)).toBe(false);
  });

  it("keeps the post while another action is still on it", () => {
    adoptMyActivity(ME);
    markReacted(POST, REACTION);
    markReplied(POST);
    clearReacted(POST);
    expect(myActivity().has(POST)).toBe(true);
    expect(hasDone("replied", POST)).toBe(true);
  });

  it("does not leak one key's actions to another", () => {
    adoptMyActivity(ME);
    markReacted(POST, REACTION);
    adoptMyActivity(OTHER);
    expect(hasDone("react", POST)).toBe(false);
    adoptMyActivity(ME);
    expect(hasDone("react", POST)).toBe(true);
  });
});

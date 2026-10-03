/**
 * The two web storages, where a refusal is an answer rather than an exception.
 *
 * `localStorage` and `sessionStorage` throw rather than report: a browser that
 * has storage turned off, a locked profile and a private window all make
 * `getItem` and `setItem` throw a `SecurityError`, and a quota that is already
 * full makes `setItem` throw on its own. Every one of those is a fact about the
 * browser, not about the thing being remembered — a theme, a relay set, a
 * sensitive-content setting, a session — and the app is written to work without
 * any of them being persisted. That is only true if the throw is caught, and each
 * of the modules that keeps a copy of the reader's state had grown its own idea
 * of how to do that, with a gap in a different place in each:
 *
 * - `auth.tsx` wrote the session from inside the `try` meant for a bad key, so a
 *   browser refusing to remember it reported **"秘密鍵が不正です"** — an invalid
 *   secret for a key it had just accepted — and, because the throw came out of the
 *   `setPubkey` that ran a line earlier, the app was left signed in with no
 *   method and no signer on any connection.
 * - Its `removeItem` on sign-out ran before `applySignerToConnections(null)`, so a
 *   refusal there left every relay connection still holding the key: posts
 *   published as the reader while the interface said they were not.
 * - `my-actions.ts` guarded its `JSON.parse` and left the `getItem` bare, and that
 *   read runs inside a signal update the login itself triggers. A refusal landed
 *   in `loginWithNsec`'s catch — the same wrong message — or, on the write side,
 *   inside the updater of a publish that had *already been accepted by a relay*,
 *   so an action that really went out was reported as one that failed.
 *
 * One place, then, so that a module cannot keep a copy of the reader's state
 * without also inheriting the guard. What a refusal costs is small and is the
 * caller's to state: a login that cannot be remembered works until the tab
 * closes, a sign-out that cannot clear its entry may offer the session back once,
 * and an action row that cannot be stored still shows what the reader just did
 * until the page is reloaded.
 */

export interface SafeStorage {
  /** The stored value, or null when there is none or it cannot be read. */
  get(key: string): string | null;
  /** Stores a value, or forgets that it tried. */
  set(key: string, value: string): void;
  /** Removes a value, or forgets that it tried. */
  remove(key: string): void;
}

/**
 * A store whose methods answer instead of throwing.
 *
 * The guard sits around each call rather than around the lookup, which is also
 * what covers a lookup that throws: when storage is blocked for the origin, some
 * browsers throw from the property access itself, and that access happens inside
 * every one of these methods.
 */
export function safeStorage(which: "local" | "session"): SafeStorage {
  const pick = (): Storage | null =>
    which === "local"
      ? (globalThis as { localStorage?: Storage }).localStorage ?? null
      : (globalThis as { sessionStorage?: Storage }).sessionStorage ?? null;
  return {
    get(key) {
      try {
        return pick()?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        pick()?.setItem(key, value);
      } catch {
        // Nothing else to try; the caller's state stands for this visit.
      }
    },
    remove(key) {
      try {
        pick()?.removeItem(key);
      } catch {
        // Nothing else to try.
      }
    },
  };
}
export type Menu = "home" | "notifications" | "network" | "settings";

/**
 * The `/replies` suffix that selects the Replies and notes tab. The Notes
 * tab carries no suffix, so a link to a feed is the short one.
 */
const REPLIES_SUFFIX = "replies";

export type Route =
  | { name: "menu"; menu: Menu; replies: boolean }
  /** `invalid` marks a profile link that carries no usable pubkey. */
  | {
      name: "profile";
      pubkey: string | null;
      invalid: boolean;
      replies: boolean;
    }
  | { name: "event"; eventId: string };

const MENUS: Menu[] = ["home", "notifications", "network", "settings"];

function isMenu(value: string): value is Menu {
  return (MENUS as string[]).includes(value);
}

/**
 * Strips a trailing `/replies` and reports whether it was there. An
 * unrecognised trailing segment is not a tab, so it is left in place for
 * the caller to reject rather than silently read as Notes.
 */
function splitReplies(path: string): { base: string; replies: boolean } {
  // Stripped repeatedly, not once. A single greedy strip leaves a second
  // `/replies` in the base, which then matches no route and falls through — so
  // the address bar would say `replies` while the timeline showed Notes.
  let base = path;
  let replies = false;
  for (;;) {
    const match = base.match(/^(.*)\/([^/]+)$/);
    // Never strip the whole path: a bare `#/replies` names no page at all, so
    // leaving it alone is what keeps it from becoming the home tab.
    if (match === null || match[2] !== REPLIES_SUFFIX || match[1] === "") break;
    base = match[1];
    replies = true;
  }
  return { base, replies };
}

/**
 * Parse a location hash into a route. Unknown hashes fall back to home
 * so a broken link never blanks the app.
 *
 * `#/profile` is the reader's own profile and `#/profile/<pubkey>` anyone
 * else's, which is what the links in the feed use. A `/replies` suffix on
 * either a feed or a profile selects the Replies and notes tab.
 */
export function parseHash(hash: string): Route {
  const path = hash.startsWith("#") ? hash.slice(1) : hash;
  const eventMatch = path.match(/^\/event\/([0-9a-fA-F]{64})\/?$/);
  if (eventMatch) {
    return { name: "event", eventId: eventMatch[1].toLowerCase() };
  }
  // Only the feeds carry tabs, so the suffix is read before the routes that
  // would otherwise treat "replies" as a menu name or a pubkey.
  const { base, replies } = splitReplies(path);
  const profileMatch = base.match(/^\/profile(?:\/([^/]*))?\/?$/);
  if (profileMatch !== null) {
    const raw = profileMatch[1];
    if (raw === undefined || raw === "") {
      return { name: "profile", pubkey: null, invalid: false, replies };
    }
    // A broken profile link must say so: falling back to the home feed
    // would show the reader someone else's timeline without warning.
    const usable = /^[0-9a-fA-F]{64}$/.test(raw);
    return {
      name: "profile",
      pubkey: usable ? raw.toLowerCase() : null,
      invalid: !usable,
      replies,
    };
  }
  const menuMatch = base.match(/^\/([a-z]+)\/?$/);
  if (menuMatch && isMenu(menuMatch[1])) {
    return { name: "menu", menu: menuMatch[1], replies };
  }
  // Nothing matched, so this hash names no page. The tab that was asked for is
  // kept anyway: falling back to home must not also silently switch the tab,
  // or the address bar and the highlighted tab would disagree about a link
  // someone can copy and send to someone else.
  return { name: "menu", menu: "home", replies };
}

export function currentHash(): string {
  return typeof location !== "undefined" ? location.hash : "";
}

/** Normalises a link to a single leading hash. */
export function toHash(hash: string): string {
  return hash.startsWith("#") ? hash : `#${hash}`;
}

export function navigate(hash: string): void {
  if (typeof location !== "undefined") {
    location.hash = toHash(hash);
  }
}

/** Link to a profile page, own or someone else's. */
export function profileHash(pubkey: string): string {
  return `#/profile/${pubkey}`;
}

/**
 * Link to a feed tab. Notes has no suffix, so a link to the default tab
 * stays the short `#/home` form that is already in circulation.
 */
export function feedHash(base: string, replies: boolean): string {
  const path = toHash(base);
  if (!replies) return path;
  return path.endsWith("/")
    ? `${path}${REPLIES_SUFFIX}`
    : `${path}/${REPLIES_SUFFIX}`;
}

/** Go back in history, or home when there is nowhere to go back to. */
export function goBackOrHome(): void {
  if (typeof history === "undefined" || history.length <= 1) {
    navigate("#/home");
  } else {
    history.back();
  }
}

export function subscribeRoute(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
}

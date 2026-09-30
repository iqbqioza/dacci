export type Menu = "home" | "notifications" | "network" | "settings";

export type Route =
  | { name: "menu"; menu: Menu }
  /** `invalid` marks a profile link that carries no usable pubkey. */
  | { name: "profile"; pubkey: string | null; invalid: boolean }
  | { name: "event"; eventId: string };

const MENUS: Menu[] = ["home", "notifications", "network", "settings"];

function isMenu(value: string): value is Menu {
  return (MENUS as string[]).includes(value);
}

/**
 * Parse a location hash into a route. Unknown hashes fall back to home
 * so a broken link never blanks the app.
 *
 * `#/profile` is the reader's own profile and `#/profile/<pubkey>` anyone
 * else's, which is what the links in the feed use.
 */
export function parseHash(hash: string): Route {
  const path = hash.startsWith("#") ? hash.slice(1) : hash;
  const eventMatch = path.match(/^\/event\/([0-9a-fA-F]{64})\/?$/);
  if (eventMatch) {
    return { name: "event", eventId: eventMatch[1].toLowerCase() };
  }
  const profileMatch = path.match(/^\/profile(?:\/([^/]*))?\/?$/);
  if (profileMatch !== null) {
    const raw = profileMatch[1];
    if (raw === undefined || raw === "") {
      return { name: "profile", pubkey: null, invalid: false };
    }
    // A broken profile link must say so: falling back to the home feed
    // would show the reader someone else's timeline without warning.
    const usable = /^[0-9a-fA-F]{64}$/.test(raw);
    return {
      name: "profile",
      pubkey: usable ? raw.toLowerCase() : null,
      invalid: !usable,
    };
  }
  const menuMatch = path.match(/^\/([a-z]+)\/?$/);
  if (menuMatch && isMenu(menuMatch[1])) {
    return { name: "menu", menu: menuMatch[1] };
  }
  if (path === "" || path === "/") {
    return { name: "menu", menu: "home" };
  }
  return { name: "menu", menu: "home" };
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

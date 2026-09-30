export type Menu = "home" | "notifications" | "network" | "profile" | "settings";

export type Route =
  | { name: "menu"; menu: Menu }
  | { name: "event"; eventId: string };

const MENUS: Menu[] = ["home", "notifications", "network", "profile", "settings"];

function isMenu(value: string): value is Menu {
  return (MENUS as string[]).includes(value);
}

/**
 * Parse a location hash into a route. Unknown hashes fall back to home
 * so a broken link never blanks the app.
 */
export function parseHash(hash: string): Route {
  const path = hash.startsWith("#") ? hash.slice(1) : hash;
  const eventMatch = path.match(/^\/event\/([0-9a-fA-F]{64})\/?$/);
  if (eventMatch) {
    return { name: "event", eventId: eventMatch[1].toLowerCase() };
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

export function navigate(hash: string): void {
  if (typeof location !== "undefined") {
    location.hash = hash.startsWith("#") ? hash : `#${hash}`;
  }
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

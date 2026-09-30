import {
  CONTACTS_KIND,
  isHex64,
  normalizeRelayUrl,
  parseContacts,
  parseRelayList,
  RELAY_LIST_KIND,
  type Filter,
  type NostrEvent,
} from "dacci-nostr-nips";
import { createSignal } from "solid-js";
import { getConnection } from "./nostr.js";

/** Connected while logged out. */
export const DEFAULT_RELAYS = [
  "wss://relay.ditto.pub",
  "wss://relay.damus.io",
  "wss://relay.primal.net",
  "wss://relay.nostrfy.org",
];

export type RelayConnStatus =
  | "unknown"
  | "checking"
  | "online"
  | "offline"
  | "auth";

const [relayUrls, setRelayUrls] = createSignal<string[]>([...DEFAULT_RELAYS]);
const [relayStatuses, setRelayStatuses] = createSignal<
  Record<string, RelayConnStatus>
>(Object.fromEntries(DEFAULT_RELAYS.map((url) => [url, "unknown"])));
const [relayVersion, setRelayVersion] = createSignal(0);

export function useRelays() {
  return { relayUrls, relayStatuses, relayVersion };
}

export type RelayQueryFn = (
  url: string,
  filter: Filter,
) => Promise<NostrEvent[]>;

const RELAYS_STORAGE_KEY = "dacci.relays";
const FEED_STORAGE_KEY = "dacci.feed";
const MAX_STORED_RELAYS = 50;
const MAX_STORED_AUTHORS = 2000;

function readStorage(key: string): string | null {
  try {
    const storage = (globalThis as { localStorage?: Storage }).localStorage;
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    (globalThis as { localStorage?: Storage }).localStorage?.setItem(
      key,
      value,
    );
  } catch {
    // Private mode etc: run without persistence.
  }
}

function removeStorage(key: string): void {
  try {
    (globalThis as { localStorage?: Storage }).localStorage?.removeItem(key);
  } catch {
    // ignore
  }
}

function loadPersistedRelays(): string[] | null {
  try {
    const raw = readStorage(RELAYS_STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const urls = parsed
      .map((entry) =>
        typeof entry === "string" ? normalizeRelayUrl(entry) : null,
      )
      .filter((url): url is string => url !== null)
      .slice(0, MAX_STORED_RELAYS);
    return urls.length > 0 ? urls : null;
  } catch {
    return null;
  }
}

function loadPersistedFeed(): string[] | null {
  try {
    const raw = readStorage(FEED_STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const authors = parsed
      .filter((entry): entry is string => isHex64(entry))
      .slice(0, MAX_STORED_AUTHORS);
    return authors.length > 0 ? authors : null;
  } catch {
    return null;
  }
}

/**
 * Metadata lookups (kind 3 / kind 10002) must not stall the UI, so they
 * use a short timeout and race the first answer instead of waiting for
 * every relay. Whatever has not arrived yet simply stays as it was.
 */
const METADATA_TIMEOUT_MS = 4000;

async function defaultQuery(url: string, filter: Filter): Promise<NostrEvent[]> {
  const result = await getConnection(url).query(
    filter,
    METADATA_TIMEOUT_MS,
  );
  return result.failed ? [] : result.events;
}

/**
 * Runs `queryFn` against the current relays and resolves as soon as the
 * first relay answers with something. Waiting for the slowest relay would
 * make a login take as long as the worst connection, so a deadline is the
 * only thing that ends the wait.
 */
async function firstAnswer(
  filter: Filter,
  queryFn: RelayQueryFn,
): Promise<NostrEvent[]> {
  const urls = relayUrls();
  if (urls.length === 0) return [];
  return new Promise<NostrEvent[]>((resolve) => {
    let settled = false;
    const finish = (events: NostrEvent[]): void => {
      if (settled) return;
      settled = true;
      resolve(events);
    };
    const deadline = setTimeout(() => finish([]), METADATA_TIMEOUT_MS);
    for (const url of urls) {
      void queryFn(url, filter).then(
        (events) => {
          if (events.length > 0) {
            clearTimeout(deadline);
            finish(events);
          }
        },
        () => {
          // A failing relay is simply not the one that answers.
        },
      );
    }
  });
}

function setStatus(url: string, status: RelayConnStatus): void {
  setRelayStatuses((prev) => ({ ...prev, [url]: status }));
}

async function checkOne(url: string): Promise<void> {
  setStatus(url, "checking");
  try {
    const result = await getConnection(url).query({ limit: 0 }, 8000);
    setStatus(
      url,
      result.failed ? (result.authRequired ? "auth" : "offline") : "online",
    );
  } catch {
    setStatus(url, "offline");
  }
}

export async function refreshStatuses(): Promise<void> {
  await Promise.all(relayUrls().map(checkOne));
}

let refreshTimer: ReturnType<typeof setInterval> | null = null;

/** Periodically re-check statuses so drops are retried visibly. */
export function startAutoRefresh(intervalMs = 30000): () => void {
  stopAutoRefresh();
  refreshTimer = setInterval(() => {
    void refreshStatuses();
  }, intervalMs);
  return stopAutoRefresh;
}

export function stopAutoRefresh(): void {
  if (refreshTimer !== null) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

function switchTo(urls: string[]): void {
  setRelayUrls(urls);
  setRelayStatuses(Object.fromEntries(urls.map((url) => [url, "unknown"])));
  writeStorage(RELAYS_STORAGE_KEY, JSON.stringify(urls));
  bumpVersion();
  void refreshStatuses();
}

function bumpVersion(): void {
  setRelayVersion((v) => v + 1);
}

/** Logged-out state: the default relay set. */
export function restoreDefaults(): void {
  clearFeed();
  switchTo([...DEFAULT_RELAYS]);
}

/**
 * Feed author filter. Null means the global feed (logged out).
 * Logged in, it holds follows plus self.
 */
const [feedAuthors, setFeedAuthors] = createSignal<string[] | null>(null);

export function useFeed() {
  return { feedAuthors };
}

/** Clear the follow filter without touching the relay set. */
export function clearFeed(): void {
  setFeedAuthors(null);
  removeStorage(FEED_STORAGE_KEY);
}

function newestFirst(a: NostrEvent, b: NostrEvent): number {
  return a.created_at !== b.created_at
    ? b.created_at - a.created_at
    : a.id < b.id
      ? -1
      : 1;
}

/**
 * Logged-in feed: fetch the NIP-02 follow list (kind 3) and filter the
 * home timeline to follows plus self. Without a list, falls back to
 * self-only. NOTE: very large follow lists may hit relay-side filter
 * limits; correctness is preferred over silent truncation here.
 */
export async function applyLoginFeed(
  pubkey: string,
  queryFn: RelayQueryFn = defaultQuery,
): Promise<void> {
  const candidates = await firstAnswer(
    { kinds: [CONTACTS_KIND], authors: [pubkey], limit: 5 },
    queryFn,
  );
  let authors = [pubkey];
  if (candidates.length > 0) {
    candidates.sort(newestFirst);
    const follows = parseContacts(candidates[0]).filter((p) => p !== pubkey);
    authors = [pubkey, ...follows];
  }
  setFeedAuthors(authors);
  writeStorage(FEED_STORAGE_KEY, JSON.stringify(authors));
  bumpVersion();
}

/**
 * Logged-in state: resolve the NIP-65 relay list (kind 10002) and the
 * NIP-02 follow list (kind 3) from the connected relays, then reconnect to
 * the read relays and switch the feed to the follows.
 *
 * Both lookups run in parallel and each falls back to whatever was already
 * known, so the login is never blocked by a slow or dead relay. Both
 * results are persisted, so a reload keeps the login and the resolved
 * relay set instead of resetting to the defaults.
 */
export async function applyLoginProfile(
  pubkey: string,
  queryFn: RelayQueryFn = defaultQuery,
): Promise<void> {
  await Promise.all([
    applyLoginRelaySet(pubkey, queryFn),
    applyLoginFeed(pubkey, queryFn),
  ]);
}
/**
 * Logged-in state: fetch the NIP-65 relay list (kind 10002) from the
 * currently connected relays and reconnect to its read relays.
 * Keeps the current set when no list is found.
 */
export async function applyLoginRelaySet(
  pubkey: string,
  queryFn: RelayQueryFn = defaultQuery,
): Promise<void> {
  const candidates = await firstAnswer(
    { kinds: [RELAY_LIST_KIND], authors: [pubkey], limit: 5 },
    queryFn,
  );
  if (candidates.length === 0) return;
  candidates.sort(newestFirst);
  const readUrls = parseRelayList(candidates[0])
    .filter((entry) => entry.read)
    .map((entry) => entry.url);
  if (readUrls.length === 0) return;
  switchTo(readUrls);
}

/**
 * Startup entry: restore the persisted relay set and feed synchronously
 * so the first render never flashes the defaults over personal settings.
 * Falls back to defaults when nothing (valid) was stored.
 */
export function initRelays(): void {
  const urls = loadPersistedRelays() ?? [...DEFAULT_RELAYS];
  const authors = loadPersistedFeed();
  setRelayUrls(urls);
  setRelayStatuses(Object.fromEntries(urls.map((url) => [url, "unknown"])));
  setFeedAuthors(authors);
  bumpVersion();
  void refreshStatuses();
}

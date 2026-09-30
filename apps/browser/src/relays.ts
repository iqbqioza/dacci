import {
  CONTACTS_KIND,
  isHex64,
  normalizeRelayUrl,
  parseContacts,
  parseRelayInfoDocument,
  parseRelayList,
  relayInfoUrl,
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

/**
 * NIP-65 read/write markers. A relay can be asked for both, which is the
 * default; `read` never receives what the reader publishes and `write` is
 * never queried.
 */
export type RelayMode = "both" | "read" | "write";

export interface RelayEntry {
  url: string;
  mode: RelayMode;
}

/** What we know about a relay beyond its URL. */
export interface RelayInfo {
  /** NIP-66 name from the reader's relay list, or the NIP-11 name. */
  name?: string;
  description?: string;
  /** NIP-11 `supported_nips`, as written by the relay itself. */
  supportedNips?: string[];
  /** NIP-11 logo. */
  icon?: string;
  software?: string;
  version?: string;
  contact?: string;
  pubkey?: string;
  /** NIP-11 `limitation`, e.g. max message length or auth requirement. */
  limitation?: Record<string, unknown>;
  /** NIP-11 `retention`, e.g. which kinds are kept and for how long. */
  retention?: Record<string, unknown>;
  relayCount?: number;
  listeners?: number;
}

const MAX_STORED_RELAYS = 50;
const MAX_STORED_AUTHORS = 2000;
const MAX_RELAY_INFO = 200;
/** NIP-11 is a plain HTTP request to the relay's web address. */
const NIP11_TIMEOUT_MS = 4000;

function entriesFromUrls(urls: string[]): RelayEntry[] {
  return urls.map((url) => ({ url, mode: "both" as const }));
}

const [relayEntries, setRelayEntries] = createSignal<RelayEntry[]>(
  entriesFromUrls(DEFAULT_RELAYS),
);
const [relayStatuses, setRelayStatuses] = createSignal<
  Record<string, RelayConnStatus>
>(Object.fromEntries(DEFAULT_RELAYS.map((url) => [url, "unknown"])));
const [relayInfo, setRelayInfo] = createSignal<Record<string, RelayInfo>>({});
const [relayVersion, setRelayVersion] = createSignal(0);

/**
 * Derived accessors, not memos: they read the signal on every call, which
 * keeps them correct in every build of solid (a module-scope memo is
 * evaluated once in the server build the tests load) and they are cheap
 * enough to recompute for a set of at most 50 relays.
 */
/** Every relay in the set, whatever its mode. */
const relayUrls = (): string[] => relayEntries().map((entry) => entry.url);
/** Relays that may be queried. */
const readRelays = (): string[] =>
  relayEntries()
    .filter((entry) => entry.mode !== "write")
    .map((entry) => entry.url);
/** Relays that may receive what the reader publishes. */
const writeRelays = (): string[] =>
  relayEntries()
    .filter((entry) => entry.mode !== "read")
    .map((entry) => entry.url);

export function useRelays() {
  return {
    relayEntries,
    relayUrls,
    readRelays,
    writeRelays,
    relayStatuses,
    relayInfo,
    relayVersion,
  };
}

export type RelayQueryFn = (
  url: string,
  filter: Filter,
) => Promise<NostrEvent[]>;

const RELAYS_STORAGE_KEY = "dacci.relays";
const FEED_STORAGE_KEY = "dacci.feed";

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

function toMode(value: unknown): RelayMode {
  return value === "read" || value === "write" ? value : "both";
}

function loadPersistedRelays(): RelayEntry[] | null {
  try {
    const raw = readStorage(RELAYS_STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const entries: RelayEntry[] = [];
    const seen = new Set<string>();
    for (const item of parsed) {
      // A stored set used to be a plain list of URLs; those are read/write.
      const url = normalizeRelayUrl(
        typeof item === "string" ? item : (item as RelayEntry)?.url,
      );
      const mode = typeof item === "string" ? "both" : toMode((item as RelayEntry)?.mode);
      if (url === null || seen.has(url)) continue;
      seen.add(url);
      entries.push({ url, mode });
      if (entries.length >= MAX_STORED_RELAYS) break;
    }
    return entries.length > 0 ? entries : null;
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
 * Runs `queryFn` against the current read relays and resolves as soon as the
 * first one answers with something. Waiting for the slowest relay would
 * make a login take as long as the worst connection, so a deadline is the
 * only thing that ends the wait.
 */
async function firstAnswer(
  filter: Filter,
  queryFn: RelayQueryFn,
): Promise<NostrEvent[]> {
  const urls = readRelays();
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
    // limit: 0 fetches no stored events; EOSE alone proves reachability.
    const result = await getConnection(url).query({ limit: 0 }, 3000);
    setStatus(
      url,
      result.failed ? (result.authRequired ? "auth" : "offline") : "online",
    );
  } catch {
    setStatus(url, "offline");
  }
}

/**
 * Probes the relays that may be queried. A write-only relay is never asked
 * for anything, so its state is only known once a publish has been tried.
 */
export async function refreshStatuses(): Promise<void> {
  await Promise.all(readRelays().map(checkOne));
}

/** Records what a write-only relay answered, so the list can show it. */
export function noteWriteResult(url: string, accepted: boolean): void {
  setStatus(url, accepted ? "online" : "offline");
}

let refreshTimer: ReturnType<typeof setInterval> | null = null;

/** Periodically re-check statuses so drops are retried visibly. */
export function startAutoRefresh(intervalMs = 30000): () => void {
  stopAutoRefresh();
  refreshTimer = setInterval(() => {
    void refreshStatuses();
  }, intervalMs);
  return stopRefresh;
}

function stopRefresh(): void {
  if (refreshTimer !== null) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

export function stopAutoRefresh(): void {
  stopRefresh();
}

function switchTo(entries: RelayEntry[]): void {
  setRelayEntries(entries);
  setRelayStatuses(
    Object.fromEntries(entries.map((entry) => [entry.url, "unknown"] as const)),
  );
  writeStorage(RELAYS_STORAGE_KEY, JSON.stringify(entries));
  setRelayVersion((v) => v + 1);
  void refreshStatuses();
}

/** Logged-out state: the default relay set, all read/write. */
export function restoreDefaults(): void {
  clearFeed();
  switchTo(entriesFromUrls(DEFAULT_RELAYS));
}

export type RelayEditResult =
  | { ok: true }
  | { ok: false; reason: "invalid" | "duplicate" | "full" };

/**
 * Adds a relay to the set. The URL is normalized first, so `relay.example`
 * and a trailing slash cannot sneak in as a second entry.
 */
export function addRelay(value: string, mode: RelayMode = "both"): RelayEditResult {
  const url = normalizeRelayUrl(value);
  if (url === null) return { ok: false, reason: "invalid" };
  if (relayUrls().includes(url)) return { ok: false, reason: "duplicate" };
  if (relayUrls().length >= MAX_STORED_RELAYS) return { ok: false, reason: "full" };
  switchTo([...relayEntries(), { url, mode }]);
  // A write-only relay is never probed, so its state starts unknown.
  if (mode !== "write") void checkOne(url);
  return { ok: true };
}

/** Removes a relay from the set. */
export function removeRelay(url: string): void {
  const next = relayEntries().filter((entry) => entry.url !== url);
  if (next.length === relayEntries().length) return;
  switchTo(next);
}

/** Changes whether a relay is read, write or both. */
export function setRelayMode(url: string, mode: RelayMode): void {
  switchTo(
    relayEntries().map((entry) =>
      entry.url === url ? { url, mode } : entry,
    ),
  );
  if (mode !== "write") void checkOne(url);
}

function mergeInfo(url: string, info: RelayInfo): void {
  setRelayInfo((prev) => {
    const next = { ...prev, [url]: { ...prev[url], ...info } };
    // Bound the cache: relay lists are user supplied and can be long.
    const keys = Object.keys(next);
    if (keys.length > MAX_RELAY_INFO) {
      for (const key of keys.slice(0, keys.length - MAX_RELAY_INFO)) {
        delete next[key];
      }
    }
    return next;
  });
}

/**
 * NIP-11 relay information document. Most relays do not send CORS headers
 * for it, so a failure is expected and simply leaves the list as it was.
 */
async function fetchNip11(url: string): Promise<void> {
  const http = relayInfoUrl(url);
  if (http === null) return;
  try {
    const response = await fetch(http, {
      headers: { Accept: "application/nostr+json" },
      signal: AbortSignal.timeout(NIP11_TIMEOUT_MS),
    });
    if (!response.ok) return;
    const parsed = parseRelayInfoDocument(await response.json());
    if (parsed !== null) mergeInfo(url, parsed);
  } catch {
    // CORS, offline or a relay without NIP-11: nothing to show.
  }
}

/** Refreshes the information and status shown for every relay in the set. */
export async function refreshRelayInfo(): Promise<void> {
  await Promise.all([refreshStatuses(), ...relayUrls().map(fetchNip11)]);
}

/**
 * Reads the NIP-66 metadata of the reader's own relay list, which names and
 * describes each relay, and keeps it for the relays in the set.
 */
export async function loadRelayInfo(
  pubkey: string,
  queryFn: RelayQueryFn = defaultQuery,
): Promise<void> {
  const candidates = await firstAnswer(
    { kinds: [RELAY_LIST_KIND], authors: [pubkey], limit: 5 },
    queryFn,
  );
  if (candidates.length === 0) return;
  candidates.sort(newestFirst);
  for (const entry of parseRelayList(candidates[0])) {
    mergeInfo(entry.url, {
      ...(entry.name === undefined ? {} : { name: entry.name }),
      ...(entry.description === undefined
        ? {}
        : { description: entry.description }),
    });
  }
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
  setRelayVersion((v) => v + 1);
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
    loadRelayInfo(pubkey, queryFn),
  ]);
}

/**
 * Logged-in state: fetch the NIP-65 relay list (kind 10002) from the
 * currently connected relays and adopt it, read/write markers included.
 * This is the one place where the reader's list replaces the manual modes,
 * because the list is the reader's own statement of what to use.
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
  const entries: RelayEntry[] = [];
  const seen = new Set<string>();
  for (const entry of parseRelayList(candidates[0])) {
    if (seen.has(entry.url)) continue;
    seen.add(entry.url);
    entries.push({
      url: entry.url,
      // A tag with no marker serves both, per NIP-65.
      mode:
        entry.read && entry.write
          ? "both"
          : entry.read
            ? "read"
            : "write",
    });
  }
  if (entries.length === 0) return;
  switchTo(entries);
}

/**
 * Startup entry: restore the persisted relay set and feed synchronously
 * so the first render never flashes the defaults over personal settings.
 * Falls back to defaults when nothing (valid) was stored.
 */
export function initRelays(): void {
  const entries = loadPersistedRelays() ?? entriesFromUrls(DEFAULT_RELAYS);
  const authors = loadPersistedFeed();
  setRelayEntries(entries);
  setRelayStatuses(
    Object.fromEntries(entries.map((entry) => [entry.url, "unknown"] as const)),
  );
  setFeedAuthors(authors);
  setRelayVersion((v) => v + 1);
  void refreshStatuses();
}

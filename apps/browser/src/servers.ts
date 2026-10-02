import type { Filter } from "dacci-nostr-nips";
import type { NostrEvent } from "dacci-nostr-nips";
import { isSignedBy } from "./authored.js";
import { createSignal } from "solid-js";
import { useAuth } from "./auth.js";
import { publishEvent, publishFailureText } from "./compose.js";
import { getConnection } from "./nostr.js";
import { showNotice } from "./notice.js";
import { useRelays } from "./relays.js";

/**
 * Where a file can be uploaded to.
 *
 * A listed server is not necessarily a Blossom one. NIP-96 (HTTP file
 * storage, now `unrecommended` in favour of NIP-B7) and Blossom's BUD-03
 * publish the same `server` tag under different kinds, and one server often
 * speaks both: nostrcheck.me serves a NIP-96 `api_url` and a BUD-02 `/upload`
 * beside it, while nostpic.com only ever did NIP-96. So what a list says is
 * where to upload, and the request itself is decided by the server's own
 * document.
 */
export type UploadServer = {
  url: string;
  /**
   * Set on the servers the app offers itself. They are the floor rather than
   * the reader's choice, so the picker offers them and will not let them be
   * removed, and they are never published in the reader's own list.
   */
  builtin?: boolean;
};

/**
 * The kinds a file server list is published under, newest spec first. BUD-03
 * uses 10063 and NIP-96 used 10096; the latter is now deprecated, but a client
 * that only read 10063 would show an empty list for anyone who had only
 * published the old kind, so both are read and the newer one is written.
 * Neither kind says which of the two APIs the server speaks, and both are read
 * for the same `server` tag either way.
 */
const SERVER_LIST_KINDS = [10063, 10096];
/** The kind written back: BUD-03, the one clients read today. */
const CURRENT_SERVER_LIST_KIND = 10063;

/**
 * The servers the app always offers, above anything the reader has added.
 *
 * A server needs a pubkey-signed request, and the browser also needs it to
 * allow a cross-origin upload: one that does not answers every request with a
 * CORS failure no signing can fix, so it is not offered here. Every one below
 * has taken a signed upload from this app. nostr.build, the largest of them,
 * is left out because its upload endpoint answers the preflight with no CORS
 * headers at all, though it stays addable; Blossom Band, the Blossom server
 * behind the same account, is the one that works where it does not.
 *
 * None of these is written to the reader's BUD-03 list. That list is where a
 * reader declares where their blobs live, and BUD-03 has a client upload to
 * the first server in it, so putting a client's own defaults there would take
 * uploads away from the server the reader chose.
 */
export const BUILTIN_SERVERS: UploadServer[] = [
  {
    // A free account, and the one server that speaks both dialects: a NIP-96
    // `api_url` to post to and a BUD-02 `/upload` beside it. The document
    // decides which one a request uses, and the preflight for either is
    // answered, which is the part a browser cannot do without.
    url: "https://nostrcheck.me",
    builtin: true,
  },
  {
    // Blossom Band, and the one Blossom server that takes an upload from any
    // key with no account: the preflight allows the methods and headers a
    // BUD-02 upload needs, and a signed upload is answered with a Blossom URI.
    // Its well-known redirects to NIP-96's, so a client that took a redirect
    // for the host's own document would post to a NIP-96 endpoint that sends
    // no CORS headers at all.
    url: "https://blossom.band",
    builtin: true,
  },
  {
    // NIP-96, and it namespaces a file by the pubkey that uploaded it, so two
    // readers can store the same picture without meeting.
    url: "https://nostpic.com",
    builtin: true,
  },
  {
    // NIP-96, and the plainest of them: a file is its hash under the host,
    // which is what BUD-01 asks a client to be able to rebuild.
    url: "https://files.sovbit.host",
    builtin: true,
  },
];

const STORAGE_KEY = "dacci.servers";
/** When this browser last published a list, so a stale answer is ignored. */
const WRITTEN_PREFIX = "dacci.servers.written.";

// The stored list is read at module load, so a reload shows what the reader
// configured. It holds their servers only: the ones the app offers itself are
// not theirs to configure, and are added to every view of the list.
const [servers, setServers] = createSignal<UploadServer[]>(read());
/**
 * Whose published list has been read at all, and whether it has.
 *
 * BUD-03 replaces the whole list on every write, so publishing a list that was
 * never read would publish whatever happened to be on this device and delete
 * every server the reader configured elsewhere. A read that no relay answered
 * leaves the account unanswered, which is the only thing that keeps a write off.
 *
 * This is keyed by account rather than being a plain flag because the list
 * behind it is this device's, which survives a sign-out. One flag for the whole
 * app is therefore wrong for the second account of a session: signing out reads
 * no list but has nothing to publish, and marking it read left the gate open,
 * so signing back in during a failing read published this device's list under
 * an account whose own list had never been asked for.
 */
const [readFor, setReadFor] = createSignal<string | null>(null);

function read(): UploadServer[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isUploadServer);
  } catch {
    return [];
  }
}

function isUploadServer(value: unknown): value is UploadServer {
  if (typeof value !== "object" || value === null) return false;
  const url = (value as { url?: unknown }).url;
  return typeof url === "string" && isHttpUrl(url);
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\/[^\s/]+/i.test(value.trim());
}

function write(next: UploadServer[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // A browser that refuses storage still works, it just forgets.
  }
  setServers(next);
}

/**
 * Every server the picker offers: the app's own first, then the reader's, so a
 * reader can see at a glance which is which.
 */
export function useUploadServers() {
  return {
    mine: servers,
    all,
    addServer,
    removeServer,
    loadServers,
  };
}

function all(): UploadServer[] {
  // A list published on another client can name a server the app already
  // offers. Showing it twice would leave the reader wondering which of the
  // two is theirs to remove.
  return [
    ...BUILTIN_SERVERS,
    ...servers().filter(
      (server) => !BUILTIN_SERVERS.some((one) => one.url === server.url),
    ),
  ];
}

/**
 * Adds a server, refusing a duplicate or an unusable URL. One the app already
 * offers is a duplicate too: the reader's list would only put a second copy of
 * it below the first.
 */
export function addServer(url: string): "ok" | "invalid" | "duplicate" {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (!isHttpUrl(trimmed)) return "invalid";
  const known = [...BUILTIN_SERVERS, ...servers()];
  if (known.some((server) => server.url === trimmed)) return "duplicate";
  write([...servers(), { url: trimmed }]);
  return "ok";
}

export function removeServer(url: string): void {
  write(servers().filter((server) => server.url !== url));
}

/**
 * Publishes the server list as the reader's BUD-03 event, so the choice
 * follows the account onto other clients. A replaceable event is overwritten
 * by the relays, so the whole list is sent every time. BUD-03 says the
 * `content` field is not used, so it is left empty.
 */
export async function publishServers(): Promise<boolean> {
  const pubkey = useAuth().pubkey();
  if (pubkey === null) return false;
  // The list on this device may be all this device ever saw. Writing it as the
  // account's list would delete the servers the reader added elsewhere, so a
  // list that has not been read **for this account** is not published.
  if (readFor() !== pubkey) {
    showNotice("サーバー一覧を読み込んでから保存してください");
    return false;
  }
  const created_at = Math.floor(Date.now() / 1000);
  // Read before the publish, because the local list has already changed by the
  // time this runs — so an empty list now is a list this device never loaded,
  // not a list the reader just emptied.
  const mine = servers().filter((server) => server.builtin !== true);
  if (mine.length === 0) {
    showNotice("保存するサーバーがありません");
    return false;
  }
  const sent = await publishEvent(
    {
      pubkey,
      created_at,
      kind: CURRENT_SERVER_LIST_KIND,
      // The reader's own servers, and only those: BUD-03 has a client upload to
      // the first server in the list, so the app's own defaults written here
      // would take uploads away from the server the reader chose.
      tags: mine.map((server) => ["server", server.url]),
      content: "",
    },
    // The local list has already changed by the time this runs, so a failure
    // that says nothing leaves the reader looking at an edit that was never
    // written to their account — on another client the server they just added
    // is simply absent, and the one they removed is still there.
    (reason) => showNotice(publishFailureText(reason, "サーバー一覧の保存")),
  );
  if (sent === null) return false;
  // Remember when this browser wrote, so a relay answer that predates the
  // write is recognised as stale instead of undoing the edit.
  try {
    localStorage.setItem(WRITTEN_PREFIX + pubkey, String(created_at));
  } catch {
    // Without the note the read still works, it just cannot tell a stale
    // answer from a fresh one.
  }
  return true;
}

/** Adds a server and publishes the new list, so the choice is kept. */
export async function addServerAndPublish(
  url: string,
): Promise<"ok" | "invalid" | "duplicate"> {
  const result = addServer(url);
  if (result !== "ok") return result;
  await publishServers();
  return result;
}

/** Removes a server and publishes the new list. */
export async function removeServerAndPublish(url: string): Promise<boolean> {
  removeServer(url);
  return await publishServers();
}

/**
 * Reads the server list the account published, so the choice follows the
 * reader across clients: the BUD-03 kind 10063 and the NIP-96 kind 10096,
 * which list their servers the same way. The local list stays as the fallback
 * for a reader who is not signed in.
 */
/** The read in flight, so overlapping calls share one round of queries. */
let inFlight: Promise<void> | null = null;
/** The account that in-flight read belongs to. */
let inFlightFor: string | null = null;

export async function loadServers(): Promise<void> {
  // A relay round is not cheap, and the start of the app can ask more than
  // once (the session restore and the identity change overlap). One read
  // serves every caller that arrives while it runs.
  //
  // Keyed by account, because a read that is still out belongs to the account
  // that asked for it: handing it to whoever signs in next would answer the new
  // account with the old account's list, or with nothing at all.
  const key = useAuth().pubkey();
  if (inFlight !== null && inFlightFor === key) return inFlight;
  inFlightFor = key;
  inFlight = loadServersInner().finally(() => {
    inFlight = null;
    inFlightFor = null;
  });
  return inFlight;
}

async function loadServersInner(): Promise<void> {
  const pubkey = useAuth().pubkey();
  // Whatever was read last belongs to another account, and this device's list is
  // not that account's list, so the gate closes until this account has answered.
  setReadFor(null);
  if (pubkey === null) {
    setServers(read());
    // A signed-out reader has no list to publish, so there is nothing to read.
    return;
  }
  // Snapshot before the round: a reply that is stale compared with what the
  // reader has now is told apart from one that is simply the same list.
  const atStart = servers();
  try {
    const list = await fetchServerPreference(pubkey);
    // Asked and answered: whatever this device holds can be published without
    // losing a server the reader configured elsewhere. An answer with nothing
    // in it is still an answer — it says the account has published no list.
    // Guarded by the account again, so an answer that lands after a sign-out
    // or a sign-in cannot open the gate for whoever is here now.
    if (useAuth().pubkey() !== pubkey) return;
    setReadFor(pubkey);
    // Nothing published leaves the reader with what they had.
    if (list.servers.length === 0) return;
    // A relay can still be answering with a list older than the edit the
    // reader just published, so an answer that predates the newest thing
    // this browser knows about is dropped: it must never undo a change that
    // is still on screen. Anything as new or newer replaces the list, which
    // is what brings in servers published on another client.
    if (list.at < lastWrite(pubkey)) return;
    const next = dedupe(list.servers);
    if (sameServers(next, atStart)) return;
    setServers(next);
  } catch {
    // A relay that refuses leaves the stored list in place.
  }
}

/**
 * When this browser last published *this account's* list, or 0 if it never did.
 *
 * Keyed by account, because the gate above it is. One key for the whole app meant
 * the second account of a session was refused its own list whenever that list
 * predated the first account's write: signing into a second account loaded
 * nothing, the gate was marked open anyway, and the next edit published this
 * device's list under an account that had never been asked.
 */
function lastWrite(pubkey: string): number {
  try {
    const raw = localStorage.getItem(WRITTEN_PREFIX + pubkey);
    const value = raw === null ? Number.NaN : Number.parseInt(raw, 10);
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

/** True when both lists name exactly the same servers. */
function sameServers(a: UploadServer[], b: UploadServer[]): boolean {
  if (a.length !== b.length) return false;
  const have = new Set(b.map((s) => s.url));
  return a.every((s) => have.has(s.url));
}

/**
 * One round across every read relay, with the answers merged. Relays
 * disagree about which kinds they store, so a single relay answering
 * nothing must not decide the result.
 *
 * Throws when not one relay answered, for the same reason the profile store
 * does: an empty answer has to mean "asked, and there is nothing published",
 * because that is the only answer that lets the list be replaced. A round where
 * every relay refused has to stay a question.
 */
async function oneQuery(filter: Filter): Promise<unknown[]> {
  const urls = useRelays().readRelays();
  if (urls.length === 0) throw new Error("no relay can be read from");
  // A relay that refused still settles its promise, so what answered is
  // counted by what each relay said. Counting settled promises instead would
  // make a round where every relay failed look like one where every relay
  // answered, and the list would be published as if it were the whole of it.
  let answered = 0;
  const settled = await Promise.allSettled(
    urls.map(async (url) => {
      const result = await getConnection(url).query(filter, 4000);
      if (result.failed) return [];
      answered += 1;
      return result.events;
    }),
  );
  if (answered === 0) throw new Error("no relay answered");
  return settled.flatMap((r) =>
    r.status === "fulfilled" ? r.value : ([] as unknown[]),
  );
}

/** A read list, with when the event behind it was published. */
interface FetchedList {
  servers: UploadServer[];
  /** The newest `created_at` behind the list, or 0 when it carried none. */
  at: number;
}

async function fetchServerPreference(pubkey: string): Promise<FetchedList> {
  // No `limit`: the read relays disagree about which kinds they store, so
  // asking each for a single event can lose the whole list to one relay that
  // happens to answer first with nothing. Every reply is merged.
  //
  // Which makes the answer the one unbounded thing here, and it decides the order
  // of the two steps below. Verifying first looked like the obvious reading, and
  // it let a single relay spend the reader's main thread: a signature check is
  // hundreds of times the cost of the id check, a few hundred forged events is
  // over a second of blocked tab, and this runs on every app start. So the list is
  // narrowed to the few events that could actually be used, and only those are
  // verified.
  const answer = (await oneQuery({
    kinds: SERVER_LIST_KINDS,
    authors: [pubkey],
  })) as NostrEvent[];
  const events = signedCandidates(answer, pubkey);
  // A replaceable event: relays lag behind each other, so only the newest
  // answer describes the list the reader has now. The newer kind wins over
  // an older one even when its copy was published earlier, because the
  // reader has since moved to it.
  const out: UploadServer[] = [];
  let at = 0;
  // A relay may answer with events of other kinds than were asked for, so
  // the list is matched on its own kind rather than on the filter alone.
  for (const event of newestPerKind(
    events.filter((e) => SERVER_LIST_KINDS.includes(kindOf(e))),
  )) {
    const created = (event as { created_at?: unknown }).created_at;
    if (typeof created === "number" && created > at) at = created;
    const tags = (event as { tags?: unknown }).tags;
    if (Array.isArray(tags)) {
      for (const tag of tags) {
        if (Array.isArray(tag) && tag[0] === "server" && typeof tag[1] === "string") {
          out.push({ url: tag[1].replace(/\/+$/, "") });
        }
      }
    }
  }
  return { servers: out, at };
}

/** The kind of an event, or -1 when it does not say. */
function kindOf(event: unknown): number {
  const kind = (event as { kind?: unknown }).kind;
  return typeof kind === "number" ? kind : -1;
}

/**
 * The newest copy of each replaceable kind. Both list kinds are read, so a
 * reader who published under the old one still gets their servers.
 */
/**
 * The signed events of a replaceable list, newest per kind, and how many of each
 * kind were looked at.
 *
 * The store only ever reads the newest event of each kind, so verifying the whole
 * answer verified events nothing could use — and the answer is unbounded, since
 * the filter carries no `limit`. A bounded walk per kind instead: the newest that
 * the reader signed, out of a few candidates. The bound matters because the second
 * candidate is not a formality — relays merge, so a forgery timestamped newer than
 * the truth is picked first and dropping it outright would throw away the real
 * event another relay had already sent.
 */
const CANDIDATES_PER_KIND = 3;

function signedCandidates(events: NostrEvent[], pubkey: string): NostrEvent[] {
  const byKind = new Map<number, NostrEvent[]>();
  for (const event of events) {
    const kind = event.kind;
    if (!SERVER_LIST_KINDS.includes(kind)) continue;
    const list = byKind.get(kind) ?? [];
    list.push(event);
    byKind.set(kind, list);
  }
  const out: NostrEvent[] = [];
  for (const list of byKind.values()) {
    list.sort((a, b) =>
      b.created_at !== a.created_at
        ? b.created_at - a.created_at
        : a.id < b.id
          ? -1
          : 1,
    );
    for (const event of list.slice(0, CANDIDATES_PER_KIND)) {
      if (isSignedBy(event, pubkey)) {
        out.push(event);
        break;
      }
    }
  }
  return out;
}

function newestPerKind(events: unknown[]): unknown[] {  const byKind = new Map<number, { at: number; event: unknown }>();
  for (const event of events) {
    const kind = (event as { kind?: unknown }).kind;
    const at = (event as { created_at?: unknown }).created_at;
    if (typeof kind !== "number" || typeof at !== "number") continue;
    const current = byKind.get(kind);
    if (current === undefined || at > current.at) byKind.set(kind, { at, event });
  }
  // The current kind first, so a reader who has both is served the one that
  // clients read today.
  return [...byKind.entries()]
    .sort(([a], [b]) => (a === CURRENT_SERVER_LIST_KIND ? -1 : b === CURRENT_SERVER_LIST_KIND ? 1 : a - b))
    .map(([, value]) => value.event);
}

function dedupe(list: UploadServer[]): UploadServer[] {
  const seen = new Set<string>();
  const out: UploadServer[] = [];
  for (const server of list) {
    if (seen.has(server.url)) continue;
    seen.add(server.url);
    out.push(server);
  }
  return out;
}

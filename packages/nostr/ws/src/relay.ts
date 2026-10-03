import {
  hasValidId,
  isAuthRequiredMessage,
  isRelayMessage,
  isValidEventStructure,
  matchesFilter,
  type Filter,
  type NostrEvent,
} from "dacci-nostr-nips";

/** Minimal socket surface so tests can inject a fake. */
export interface Socket {
  send(data: string): void;
  close(): void;
  onmessage: ((data: string) => void) | null;
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
}

export type SocketFactory = (url: string) => Socket;

export interface QueryResult {
  events: NostrEvent[];
  /** True when EOSE arrived without CLOSED/timeout. */
  eose: boolean;
  /** True when CLOSED, timeout, or transport error occurred. */
  failed: boolean;
  /** True when the relay demanded NIP-42 auth (challenge or auth-required). */
  authRequired: boolean;
}

export interface PublishResult {
  accepted: boolean;
  message: string;
  /**
   * True when a relay actually sent an `OK` for this event, whatever it said.
   *
   * NIP-01's `OK` with `false` is an answer: `duplicate`, `pow`, `rate-limited`,
   * `blocked`, `invalid`, `restricted` all describe the event, not the
   * connection, and most of them mean the relay is working exactly as intended.
   * Reading "refused" as "unreachable" turned a relay that had already stored
   * the post into a row the reader was told was down.
   *
   * False means nobody answered: a closed socket, a handshake that failed, or a
   * timeout. That is the only shape in which the relay is genuinely unreachable.
   */
  fromRelay: boolean;
}

/**
 * Signs a NIP-42 challenge for the given relay URL.
 * Return the signed kind-22242 event to send back as ["AUTH", event].
 */
export type AuthSigner = (
  challenge: string,
  relayUrl: string,
) => NostrEvent | Promise<NostrEvent>;

export interface RelayOptions {
  signer?: AuthSigner;
  /** Reconnect automatically after unexpected drops. Default true. */
  autoReconnect?: boolean;
  baseReconnectMs?: number;
  maxReconnectMs?: number;
  /**
   * Grace window before the first REQ, waiting for a NIP-42 challenge.
   * A REQ is never sent inside it, so an auth-required relay cannot see a
   * query before AUTH. It costs one window per connection, not per query,
   * because the gate stays open afterwards.
   */
  authGateProbeMs?: number;
  /**
   * Window used once the relay has actually demanded auth: there the gate
   * stays closed until AUTH is answered. A REQ is never sent before that.
   */
  authGateMs?: number;
  onStatusChange?: (status: RelayConnState) => void;
}

export type RelayConnState = "connecting" | "open" | "closed";

function defaultFactory(url: string): Socket {
  const ws = new WebSocket(url);
  const socket: Socket = {
    send: (data) => ws.send(data),
    close: () => ws.close(),
    onmessage: null,
    onopen: null,
    onerror: null,
    onclose: null,
  };
  ws.onmessage = (ev) => socket.onmessage?.(String(ev.data));
  ws.onopen = () => socket.onopen?.();
  ws.onerror = () => socket.onerror?.();
  ws.onclose = () => socket.onclose?.();
  return socket;
}

function newSubscriptionId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * How many NIP-42 challenges one connection will answer.
 *
 * Answering costs the reader a confirmation prompt when the signer is a NIP-07
 * extension, and a relay may send a distinct challenge for as long as it likes.
 * A handful is enough for the reconnects and re-subscribes a real relay causes;
 * past that, refusing leaves it unauthenticated, which is already what happens
 * when a prompt is declined.
 */
const MAX_CHALLENGES_ANSWERED = 5;

type SubOutcome = "eose" | "failed";

interface PendingSub {
  events: NostrEvent[];
  authRequired: boolean;
  timer: ReturnType<typeof setTimeout>;
  resolve: (outcome: SubOutcome) => void;
  /**
   * What was asked for. A relay may answer with anything on the open id, and
   * these events are merged into the caller's page and sorted in, so the filter
   * has to be re-checked here rather than trusted to the relay.
   */
  filter: Filter;
}

interface PendingPublish {
  timer: ReturnType<typeof setTimeout>;
  resolve: (result: PublishResult) => void;
}

export interface LiveSubscription {
  /** Stable across reconnects so callers can identify it. */
  id: string;
  unsubscribe(): void;
}

interface LiveSubEntry {
  id: string;
  filter: Filter;
  /** Events received after EOSE (live phase). */
  onEvent: (event: NostrEvent) => void;
  /** Fired once the stored-event phase completes. */
  onEose?: () => void;
  onAuthRequired?: () => void;
}

/**
 * One persistent connection per relay URL. Subscriptions multiplex over
 * the single socket and route by subscription id, so concurrent queries
 * never clobber each other. Unexpected drops reconnect forever until
 * close() is called explicitly.
 */
export class RelayConnection {
  private socket: Socket | null = null;
  private openWaiters: Array<() => void> = [];
  private failWaiters: Array<() => void> = [];
  private readonly pendingSubs = new Map<string, PendingSub>();
  /**
   * Publishes in flight, by event id, each id holding every caller waiting on it.
   *
   * A list rather than one waiter, because a caller may publish the same event
   * twice over — a double press on repost or react builds one event, and the
   * transport is reached twice.
   */
  private readonly pendingPublishes = new Map<string, PendingPublish[]>();
  private readonly liveSubs = new Map<string, LiveSubEntry>();
  /**
   * Last NIP-42 challenge seen while no signer was configured. After a
   * reload the extension signer is attached only once the session is
   * restored, so the challenge that arrived with the first REQ would
   * otherwise be dropped and the relay would stay unauthorized forever.
   */
  private pendingChallenge: string | null = null;
  /**
   * NIP-42 gate. A relay may demand auth on connect, so no REQ goes out
   * until the challenge has been answered (or the gate window closes for a
   * relay that does not require auth). Re-armed on every new socket.
   */
  private authGateOpen = false;
  private authGateWaiters: Array<() => void> = [];
  /**
   * Which connection the gate belongs to. A timer armed for one socket must
   * not open the gate for the next: after a drop `ensureSocket` closes the
   * gate again for the fresh challenge, and a stale timer firing then would
   * send REQ ahead of AUTH on an auth-required relay.
   */
  private authGateGeneration = 0;
  /** Set once the relay rejected us for auth, to re-arm the gate. */
  private authRequiredOnConnection = false;
  private readonly answeredChallenges = new Set<string>();
  private isOpen = false;
  private connStatus: RelayConnState = "closed";
  private explicitClose = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;

  constructor(
    readonly url: string,
    private readonly factory: SocketFactory = defaultFactory,
    private readonly options: RelayOptions = {},
  ) {}

  get status(): RelayConnState {
    return this.connStatus;
  }

  /** True once a NIP-42 signer has been attached to this connection. */
  get hasSigner(): boolean {
    return this.options.signer !== undefined;
  }

  setSigner(signer: AuthSigner | undefined): void {
    this.options.signer = signer;
    // A challenge may have arrived before the session was restored.
    if (signer !== undefined && this.pendingChallenge !== null) {
      const challenge = this.pendingChallenge;
      this.pendingChallenge = null;
      void this.answerChallenge(challenge).finally(() => this.openAuthGate());
    }
  }

  private setStatus(status: RelayConnState): void {
    this.connStatus = status;
    this.options.onStatusChange?.(status);
  }

  private baseReconnectMs(): number {
    return this.options.baseReconnectMs ?? 1000;
  }

  private maxReconnectMs(): number {
    return this.options.maxReconnectMs ?? 60000;
  }

  /**
   * Central drop handler: every unexpected close funnels here so the
   * connection is retried forever until close() is called explicitly.
   */
  private handleDisconnect(): void {
    this.isOpen = false;
    this.setStatus("closed");
    this.failPending("disconnected");
    if (this.explicitClose || this.options.autoReconnect === false) return;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null || this.explicitClose) return;
    const delay = Math.min(
      this.baseReconnectMs() * 2 ** this.reconnectAttempts,
      this.maxReconnectMs(),
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.explicitClose) return;
      this.reconnectAttempts += 1;
      // Drop the dead socket so the next ensureSocket dials again.
      this.socket = null;
      this.setStatus("connecting");
      this.ensureSocket();
    }, delay);
  }

  private ensureSocket(): Socket {
    if (this.socket) return this.socket;
    const socket = this.factory(this.url);
    this.socket = socket;
    // A fresh connection gets a fresh challenge, so the gate closes again.
    this.authGateOpen = false;
    this.authGateGeneration += 1;
    this.authRequiredOnConnection = false;
    // And so the prompt budget starts over. The count is there to stop a relay
    // from asking for a signature once per challenge it invents; carried across
    // sockets it stopped counting reconnects instead, and reconnects are
    // unbounded. Five drops — a relay restart, a network flap, a laptop waking —
    // and the sixth connection could never authenticate again for the rest of
    // the page's life, leaving its history permanently empty.
    this.answeredChallenges.clear();
    this.setStatus("connecting");
    // Both handlers are guarded on still being the current socket. A browser
    // fires `error` and then `close` for the same socket, so the first one puts a
    // reconnect on the timer; by the time the second arrives the redial may
    // already have installed a healthy socket, and without this the stale
    // `close` would fail every query and publish in flight on that healthy
    // connection, flip the status to closed, orphan it without closing it, and
    // dial a third — a relay with one flaky frame would refuse to settle
    // anything until the tab was reloaded.
    const isCurrent = (): boolean => this.socket === socket;
    socket.onopen = () => {
      if (!isCurrent()) {
        // A socket that was replaced before it opened is nobody's connection.
        socket.close();
        return;
      }
      this.isOpen = true;
      this.reconnectAttempts = 0;
      if (this.reconnectTimer !== null) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.setStatus("open");
      this.openWaiters.splice(0).forEach((run) => run());
      // Live subscriptions do not survive a drop; re-open them.
      this.resubscribeLive(socket);
    };
    const fail = () => {
      if (!isCurrent()) return;
      this.failWaiters.splice(0).forEach((run) => run());
      this.handleDisconnect();
    };
    socket.onerror = fail;
    socket.onclose = fail;
    socket.onmessage = (data) => this.dispatch(data);
    return socket;
  }

  private resubscribeLive(socket: Socket): void {
    for (const entry of this.liveSubs.values()) {
      void this.sendLiveReq(entry);
    }
  }

  /**
   * Opens a live subscription, but only after the NIP-42 gate is open: a
   * REQ must never reach an auth-required relay before AUTH.
   */
  private async sendLiveReq(entry: LiveSubEntry): Promise<void> {
    const opened = await this.waitOpen(10000);
    if (!opened) return;
    await this.waitAuthGate(10000);
    // Unsubscribed while the gate was closed: never open it afterwards.
    if (this.liveSubs.get(entry.id) !== entry) return;
    const socket = this.socket;
    if (socket === null) return;
    this.safeSend(socket, JSON.stringify(["REQ", entry.id, entry.filter]));
  }

  /**
   * NIP-42 gate: resolves once the relay's challenge has been answered, or
   * after `authGateMs` when the relay never asks for auth. When a challenge
   * did arrive but cannot be signed yet, the window still has to expire, so
   * a logged-out client is not blocked forever.
   */
  private waitAuthGate(timeoutMs: number): Promise<void> {
    if (this.authGateOpen) return Promise.resolve();
    const budget = this.authRequiredOnConnection
      ? (this.options.authGateMs ?? timeoutMs)
      : (this.options.authGateProbeMs ?? Math.min(timeoutMs, 1200));
    if (budget <= 0) {
      this.openAuthGate();
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const generation = this.authGateGeneration;
      const timer = setTimeout(() => {
        this.authGateWaiters = this.authGateWaiters.filter((w) => w !== done);
        if (generation === this.authGateGeneration) {
          this.openAuthGate();
          resolve();
          return;
        }
        // The connection turned over while parked: a drop and reconnect
        // re-armed a fresh, closed gate for the new socket's own challenge.
        // Resolving here would send this waiter out ahead of that challenge,
        // and merely staying silent would strand it — no timer is armed for
        // it in the new generation. So it parks again on the gate as it is
        // now, with a fresh window, the way a query that arrived after the
        // reconnect would. When the churn stops the new gate opens or times
        // out on its own and releases it; `close()` releases it sooner.
        void this.waitAuthGate(timeoutMs).then(resolve);
      }, budget);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      this.authGateWaiters.push(done);
    });
  }

  private openAuthGate(): void {
    if (this.authGateOpen) return;
    this.authGateOpen = true;
    this.authGateWaiters.splice(0).forEach((run) => run());
  }

  /**
   * Called after a fresh login: the session can sign challenges, so the
   * gate no longer has to hold REQs back.
   */
  resetAuthGate(): void {
    this.authGateOpen = true;
    this.authGateWaiters.splice(0).forEach((run) => run());
  }

  private waitOpen(timeoutMs: number): Promise<boolean> {
    // A connection that has been closed stays closed. Every query and publish
    // comes through here first, and without this one that started before `close()`
    // and reached it later went on to dial a *fresh* socket — a socket
    // `explicitClose` would then refuse to tear down, so the REQ went out to a
    // connection nobody was looking after and its answer never came.
    if (this.explicitClose) return Promise.resolve(false);
    if (this.isOpen) return Promise.resolve(true);
    return new Promise((resolve) => {
      // Both entries leave when either settles. Leaving one behind parked a
      // closure in the other list until the next open or drop, so every query
      // and publish that started while the socket was connecting left something
      // behind — on a relay that reconnects often, both lists grew for as long
      // as the tab was open. Calling an already-settled resolver is a no-op, but
      // the memory is real over a long session.
      const settle = (opened: boolean): void => {
        clearTimeout(timer);
        this.openWaiters = this.openWaiters.filter((w) => w !== done);
        this.failWaiters = this.failWaiters.filter((w) => w !== fail);
        resolve(opened);
      };
      let timer: ReturnType<typeof setTimeout>;
      const done = (): void => settle(true);
      const fail = (): void => settle(false);
      timer = setTimeout(() => settle(false), timeoutMs);
      this.openWaiters.push(done);
      this.failWaiters.push(fail);
    });
  }

  private safeSend(socket: Socket, payload: string): void {
    try {
      socket.send(payload);
    } catch {
      // Socket died mid-flight; the drop handler owns recovery.
    }
  }

  private dispatch(data: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (!isRelayMessage(msg)) return;
    if (msg[0] === "EVENT" && typeof msg[1] === "string") {
      const sub = this.pendingSubs.get(msg[1]);
      const live = this.liveSubs.get(msg[1]);
      // Shape, then identity. The id is the sha256 of the event's own fields,
      // so checking it is what makes an id mean anything: without it a relay can
      // serve rewritten content under someone else's id, and every list, deep
      // link and dedupe keyed on that id would be describing a different event.
      // It costs one hash per event and it is the only place every inbound event
      // passes through.
      if (
        sub &&
        isValidEventStructure(msg[2]) &&
        hasValidId(msg[2] as NostrEvent) &&
        // And what it has to do with this subscription, which is the same check
        // the live branch below makes. A relay can put anything on an open id,
        // and a query's events are merged into the page and sorted in, so a kind
        // 4 answering a feed that asked for notes — or one event dated far in the
        // future — would be taken as part of the answer. The filters that can be
        // pinned to a time only bound time when they carry `until`, and a
        // `since`-only filter cannot hold a future-dated post back: NIP-01 gives
        // no upper bound, so every conforming relay will happily store one.
        matchesFilter(msg[2] as NostrEvent, sub.filter)
      ) {
        sub.events.push(msg[2] as NostrEvent);
      } else if (
        live &&
        isValidEventStructure(msg[2]) &&
        hasValidId(msg[2] as NostrEvent) &&
        // And what it has to do with this subscription. A relay can push any
        // event it likes on an open id, and the buffers below take whatever
        // arrives: a kind 4 DM would be delivered to a feed that asked for
        // notes, and a single event dated far in the future would sit at the top
        // of the reader's list permanently.
        matchesFilter(msg[2] as NostrEvent, live.filter)
      ) {
        live.onEvent(msg[2] as NostrEvent);
      }
    } else if (msg[0] === "EOSE" && typeof msg[1] === "string") {
      // A live subscription stays open past EOSE; a one-shot query ends.
      const live = this.liveSubs.get(msg[1]);
      if (live !== undefined) {
        live.onEose?.();
      } else {
        this.finishSub(msg[1], "eose");
      }
    } else if (msg[0] === "CLOSED" && typeof msg[1] === "string") {
      const sub = this.pendingSubs.get(msg[1]);
      const live = this.liveSubs.get(msg[1]);
      if (sub !== undefined && isAuthRequiredMessage(msg[2])) {
        sub.authRequired = true;
      }
      if (isAuthRequiredMessage(msg[2])) {
        // Rejected for auth: close the gate again so the next attempt waits
        // for a fresh challenge instead of firing another doomed REQ.
        this.authRequiredOnConnection = true;
        this.authGateOpen = false;
      }
      if (live !== undefined) {
        // Relay refused the live stream (often auth); surface and drop it.
        if (isAuthRequiredMessage(msg[2])) live.onAuthRequired?.();
        this.liveSubs.delete(msg[1]);
      }
      this.finishSub(msg[1], "failed");
    } else if (msg[0] === "OK" && typeof msg[1] === "string") {
      // NIP-01 answers per event id, so one OK covers every wait for that event.
      // Holding a list rather than a single waiter is what keeps two concurrent
      // publishes of one event from clobbering each other: the second used to
      // overwrite the first, so the first was dropped and reported a timeout
      // while its own timeout went on to delete the second's entry and report
      // that one as refused too.
      const waiting = this.pendingPublishes.get(msg[1]);
      if (waiting !== undefined) {
        this.pendingPublishes.delete(msg[1]);
        // NIP-01 puts a boolean third and a machine-readable prefix fourth, and
        // the two are obeyed as types rather than trusted as values. `accepted`
        // is declared a boolean, so handing it whatever arrived meant a relay
        // sending `["OK", id, "false", ""]` produced the *string* `"false"` in a
        // field typed `boolean` — truthy, and a publish that reads as delivered
        // under any check looser than `=== true`. Nothing in this app was that
        // loose, so the field simply disagreed with its own type until a caller
        // was. A relay that does not follow the shape is read as refusing, which
        // is the direction that does not tell the reader their post went out.
        const accepted = msg[2] === true;
        const message =
          typeof msg[3] === "string" && msg[3] !== ""
            ? msg[3]
            : accepted
              ? ""
              : "malformed: no reason given";
        for (const pending of waiting) {
          clearTimeout(pending.timer);
          // The relay spoke either way, so it answered even when the answer was
          // not one NIP-01 describes.
          pending.resolve({ accepted, message, fromRelay: true });
        }
      }
    } else if (msg[0] === "AUTH" && typeof msg[1] === "string") {
      // Connection-level challenge: flag every pending query, then answer
      // and only then release the gate so no REQ races ahead of AUTH.
      for (const sub of this.pendingSubs.values()) {
        sub.authRequired = true;
      }
      this.authRequiredOnConnection = true;
      void this.answerChallenge(msg[1]).finally(() => {
        if (this.options.signer !== undefined) this.openAuthGate();
      });
    }
  }

  private finishSub(subId: string, outcome: SubOutcome): void {
    const sub = this.pendingSubs.get(subId);
    if (sub === undefined) return;
    this.pendingSubs.delete(subId);
    clearTimeout(sub.timer);
    sub.resolve(outcome);
  }

  private dropWaiter(
    eventId: string,
    resolve: (result: PublishResult) => void,
  ): void {
    const waiting = this.pendingPublishes.get(eventId);
    if (waiting === undefined) return;
    const at = waiting.findIndex((entry) => entry.resolve === resolve);
    if (at !== -1) waiting.splice(at, 1);
    // The key goes only once nobody is left waiting on it, so one caller timing
    // out cannot take the others' entries with it.
    if (waiting.length === 0) this.pendingPublishes.delete(eventId);
  }

  /**
   * Answers every query and publish still waiting, and says why.
   *
   * The reason is the message a refused publish carries, because that is the only
   * place a caller reads it: `"connection closed"` for a shutdown, and anything
   * else for a drop. Nothing here distinguishes the two on its own, so the word
   * has to be passed rather than inferred.
   */
  private failPending(reason: string): void {
    for (const [subId, sub] of this.pendingSubs) {
      this.pendingSubs.delete(subId);
      clearTimeout(sub.timer);
      sub.resolve("failed");
    }
    for (const [id, waiting] of this.pendingPublishes) {
      this.pendingPublishes.delete(id);
      for (const pending of waiting) {
        clearTimeout(pending.timer);
        pending.resolve({ accepted: false, message: reason, fromRelay: false });
      }
    }
  }

  private async answerChallenge(challenge: string): Promise<void> {
    if (this.options.signer === undefined) {
      // Hold on to it: setSigner() answers as soon as the session exists.
      this.pendingChallenge = challenge;
      return;
    }
    if (this.answeredChallenges.has(challenge)) return;
    // A NIP-07 signer asks the reader to confirm, so an unbounded run of
    // challenges is an unbounded run of prompts. A relay can send as many
    // distinct challenge strings as it likes, and the dedupe above only catches
    // repeats, so one relay the reader merely reads from could pop a dialog for
    // every one of them. Bailing out after a few leaves the relay
    // unauthenticated — the gate stays shut and its queries time out, which is
    // what already happens when the reader declines a prompt — rather than
    // training the reader to click through them.
    if (this.answeredChallenges.size >= MAX_CHALLENGES_ANSWERED) return;
    this.answeredChallenges.add(challenge);
    try {
      const authEvent = await this.options.signer(challenge, this.url);
      const socket = this.socket;
      if (socket !== null) {
        this.safeSend(socket, JSON.stringify(["AUTH", authEvent]));
      }
    } catch {
      // Signing failed; the pending queries time out or CLOSE below.
    }
  }

  async query(filter: Filter, timeoutMs = 10000): Promise<QueryResult> {
    this.ensureSocket();
    const opened = await this.waitOpen(timeoutMs);
    if (!opened) {
      return { events: [], eose: false, failed: true, authRequired: false };
    }
    // Never send a REQ before the NIP-42 challenge has been answered.
    await this.waitAuthGate(timeoutMs);
    // Checked again here, because the gate is the other await between the start
    // and the send. A connection closed while this one waited has nothing to
    // query, and saying so is better than dialling one nobody asked for.
    if (this.explicitClose) {
      return { events: [], eose: false, failed: true, authRequired: false };
    }
    // The socket may have been replaced while waiting; use the live one.
    const socket = this.ensureSocket();
    const subId = newSubscriptionId();
    let entryRef: PendingSub | undefined;
    const outcome = await new Promise<SubOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingSubs.delete(subId);
        resolve("failed");
      }, timeoutMs);
      entryRef = { events: [], authRequired: false, timer, resolve, filter };
      this.pendingSubs.set(subId, entryRef);
      this.safeSend(socket, JSON.stringify(["REQ", subId, filter]));
    });
    // The dispatcher mutates entryRef in place, so partial results survive
    // timeouts and drops even though the map entry is gone.
    const finished = entryRef ?? { events: [], authRequired: false };
    this.safeSend(this.socket ?? socket, JSON.stringify(["CLOSE", subId]));
    return {
      events: finished.events,
      eose: outcome === "eose",
      failed: outcome !== "eose",
      authRequired: finished.authRequired,
    };
  }

  /**
   * Open a long-lived subscription. Events received before EOSE are also
   * delivered to onEvent, so callers can render immediately and dedupe
   * against whatever historical pagination already loaded.
   */
  subscribe(
    filter: Filter,
    onEvent: (event: NostrEvent) => void,
    hooks: { onEose?: () => void; onAuthRequired?: () => void } = {},
  ): LiveSubscription {
    this.ensureSocket();
    const id = newSubscriptionId();
    const entry: LiveSubEntry = {
      id,
      filter,
      onEvent,
      onEose: hooks.onEose,
      onAuthRequired: hooks.onAuthRequired,
    };
    this.liveSubs.set(id, entry);
    // While the socket is still opening, onopen -> resubscribeLive sends it.
    // Sending from both paths would open the subscription twice.
    if (this.isOpen) void this.sendLiveReq(entry);
    return {
      id,
      unsubscribe: () => {
        this.liveSubs.delete(id);
        const current = this.socket;
        if (current !== null) {
          this.safeSend(current, JSON.stringify(["CLOSE", id]));
        }
      },
    };
  }

  /**
   * Publish an event and wait for the relay OK response.
   * NIP-42 challenges encountered mid-publish are answered when a
   * signer is configured.
   */
  async publish(event: NostrEvent, timeoutMs = 10000): Promise<PublishResult> {
    this.ensureSocket();
    const opened = await this.waitOpen(timeoutMs);
    if (!opened) {
      return { accepted: false, message: "connection failed", fromRelay: false };
    }
    await this.waitAuthGate(timeoutMs);
    // As in `query`: a connection closed while this publish waited for the gate
    // has nothing to carry it.
    if (this.explicitClose) {
      return { accepted: false, message: "connection closed", fromRelay: false };
    }
    const socket = this.ensureSocket();
    const outcome = await new Promise<PublishResult>((resolve) => {
      const timer = setTimeout(() => {
        this.dropWaiter(event.id, resolve);
        resolve({ accepted: false, message: "timeout", fromRelay: false });
      }, timeoutMs);
      const waiting = this.pendingPublishes.get(event.id);
      if (waiting === undefined) {
        this.pendingPublishes.set(event.id, [{ timer, resolve }]);
      } else {
        waiting.push({ timer, resolve });
      }
      this.safeSend(socket, JSON.stringify(["EVENT", event]));
    });
    return outcome;
  }

  /**
   * Shuts the connection down for good, and answers everything still waiting on
   * it.
   *
   * Answering is done here rather than left to the socket's own `close` event,
   * and that is the whole point of this method. Setting `socket` to null below is
   * what makes a replaced socket's events stale, and the handlers check for that
   * on purpose — so by the time the browser delivers `close` for the socket this
   * method just closed, the handler declines it as somebody else's connection.
   * Every in-flight query and publish was then left waiting for a timeout it had
   * already given up on, and a caller who closed a connection to abandon work got
   * abandoned work instead.
   */
  close(): void {
    this.explicitClose = true;
    this.liveSubs.clear();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.failPending("connection closed");
    // And the ones waiting for the socket to open at all, which `failPending` does
    // not see: they are not on a sub or a publish, they are on the connection.
    this.failWaiters.splice(0).forEach((run) => run());
    // And the ones parked on the NIP-42 gate. Draining `pendingSubs` answers the
    // work that reached the gate, but a caller sitting in `waitAuthGate` is on
    // neither list — closing to abandon work then left the spinner until the
    // gate window lapsed. Releasing them here lets the `explicitClose` checks
    // after the gate refuse at once instead.
    this.authGateWaiters.splice(0).forEach((run) => run());
    this.socket?.close();
    this.socket = null;
    this.isOpen = false;
    this.setStatus("closed");
  }
}

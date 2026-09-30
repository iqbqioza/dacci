import {
  isAuthRequiredMessage,
  isRelayMessage,
  isValidEventStructure,
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

type SubOutcome = "eose" | "failed";

interface PendingSub {
  events: NostrEvent[];
  authRequired: boolean;
  timer: ReturnType<typeof setTimeout>;
  resolve: (outcome: SubOutcome) => void;
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
  private readonly pendingPublishes = new Map<string, PendingPublish>();
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
    this.failPending(new Error("disconnected"));
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
    this.authRequiredOnConnection = false;
    this.setStatus("connecting");
    socket.onopen = () => {
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
      const timer = setTimeout(() => {
        this.authGateWaiters = this.authGateWaiters.filter((w) => w !== done);
        this.openAuthGate();
        resolve();
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
    if (this.isOpen) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.openWaiters = this.openWaiters.filter((w) => w !== done);
        this.failWaiters = this.failWaiters.filter((w) => w !== fail);
        resolve(false);
      }, timeoutMs);
      const done = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const fail = () => {
        clearTimeout(timer);
        resolve(false);
      };
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
      if (sub && isValidEventStructure(msg[2])) {
        sub.events.push(msg[2] as NostrEvent);
      } else if (live && isValidEventStructure(msg[2])) {
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
      const pending = this.pendingPublishes.get(msg[1]);
      if (pending !== undefined) {
        this.pendingPublishes.delete(msg[1]);
        clearTimeout(pending.timer);
        pending.resolve({ accepted: msg[2], message: msg[3] });
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

  private failPending(_reason: unknown): void {
    for (const [subId, sub] of this.pendingSubs) {
      this.pendingSubs.delete(subId);
      clearTimeout(sub.timer);
      sub.resolve("failed");
    }
    for (const [id, pending] of this.pendingPublishes) {
      this.pendingPublishes.delete(id);
      clearTimeout(pending.timer);
      pending.resolve({ accepted: false, message: "connection closed" });
    }
  }

  private async answerChallenge(challenge: string): Promise<void> {
    if (this.options.signer === undefined) {
      // Hold on to it: setSigner() answers as soon as the session exists.
      this.pendingChallenge = challenge;
      return;
    }
    if (this.answeredChallenges.has(challenge)) return;
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
    // The socket may have been replaced while waiting; use the live one.
    const socket = this.ensureSocket();
    const subId = newSubscriptionId();
    let entryRef: PendingSub | undefined;
    const outcome = await new Promise<SubOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingSubs.delete(subId);
        resolve("failed");
      }, timeoutMs);
      entryRef = { events: [], authRequired: false, timer, resolve };
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
      return { accepted: false, message: "connection failed" };
    }
    await this.waitAuthGate(timeoutMs);
    const socket = this.ensureSocket();
    const outcome = await new Promise<PublishResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingPublishes.delete(event.id);
        resolve({ accepted: false, message: "timeout" });
      }, timeoutMs);
      this.pendingPublishes.set(event.id, { timer, resolve });
      this.safeSend(socket, JSON.stringify(["EVENT", event]));
    });
    return outcome;
  }

  close(): void {
    this.explicitClose = true;
    this.liveSubs.clear();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close();
    this.socket = null;
    this.isOpen = false;
    this.setStatus("closed");
  }
}

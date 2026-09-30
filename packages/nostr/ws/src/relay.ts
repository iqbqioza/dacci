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
}

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
 * One persistent connection per relay URL. REQ subscriptions are
 * short-lived: query() opens a subscription, collects stored events
 * until EOSE, then closes it.
 */
export class RelayConnection {
  private socket: Socket | null = null;
  private openWaiters: Array<() => void> = [];
  private failWaiters: Array<() => void> = [];
  private isOpen = false;

  constructor(
    readonly url: string,
    private readonly factory: SocketFactory = defaultFactory,
    private readonly options: RelayOptions = {},
  ) {}

  private ensureSocket(): Socket {
    if (this.socket) return this.socket;
    const socket = this.factory(this.url);
    this.socket = socket;
    socket.onopen = () => {
      this.isOpen = true;
      this.openWaiters.splice(0).forEach((run) => run());
    };
    const fail = () => {
      this.failWaiters.splice(0).forEach((run) => run());
    };
    socket.onerror = fail;
    socket.onclose = () => {
      this.isOpen = false;
      fail();
    };
    return socket;
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

  async query(
    filter: Filter,
    timeoutMs = 10000,
  ): Promise<QueryResult> {
    const socket = this.ensureSocket();
    const opened = await this.waitOpen(timeoutMs);
    if (!opened) {
      return { events: [], eose: false, failed: true, authRequired: false };
    }
    const subId = newSubscriptionId();
    const events: NostrEvent[] = [];
    let eose = false;
    let failed = false;
    let authRequired = false;

    const done = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        failed = true;
        cleanup();
        resolve();
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        socket.onmessage = null;
        socket.send(JSON.stringify(["CLOSE", subId]));
      };
      socket.onmessage = (data) => {
        void (async () => {
          let msg: unknown;
          try {
            msg = JSON.parse(data);
          } catch {
            return;
          }
          if (!isRelayMessage(msg)) return;
          if (msg[0] === "EVENT" && msg[1] === subId) {
            const event = msg[2] as NostrEvent;
            if (isValidEventStructure(event)) events.push(event);
          } else if (msg[0] === "EOSE" && msg[1] === subId) {
            eose = true;
            cleanup();
            resolve();
          } else if (msg[0] === "CLOSED" && msg[1] === subId) {
            failed = true;
            if (isAuthRequiredMessage(msg[2])) authRequired = true;
            cleanup();
            resolve();
          } else if (msg[0] === "AUTH" && typeof msg[1] === "string") {
            // NIP-42 challenge: answer on the same connection, then
            // keep waiting for EOSE of the original subscription.
            authRequired = true;
            if (this.options.signer === undefined) return;
            try {
              const authEvent = await this.options.signer(msg[1], this.url);
              socket.send(JSON.stringify(["AUTH", authEvent]));
            } catch {
              failed = true;
              cleanup();
              resolve();
            }
          }
        })();
      };
      socket.onerror = () => {
        failed = true;
        cleanup();
        resolve();
      };
      socket.onclose = () => {
        this.isOpen = false;
        if (!eose) failed = true;
        cleanup();
        resolve();
      };
    });

    socket.send(JSON.stringify(["REQ", subId, filter]));
    await done;
    return { events, eose, failed, authRequired };
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
    this.isOpen = false;
  }
}

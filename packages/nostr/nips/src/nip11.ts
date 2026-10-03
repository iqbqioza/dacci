/**
 * NIP-11 relay information document, fetched over HTTP from the relay's web
 * address with `Accept: application/nostr+json`.
 */
export interface RelayInformation {
  name?: string;
  description?: string;
  /** URL of the relay's logo, drawn in the relay list. */
  icon?: string;
  pubkey?: string;
  contact?: string;
  software?: string;
  version?: string;
  limitation?: Record<string, unknown>;
  retention?: Record<string, unknown>;
  relayCount?: number;
  listeners?: number;
  /**
   * `limitation.max_subscriptions`: how many subscriptions this relay will keep
   * open on one connection at a time.
   *
   * Read out of `limitation` and typed, because a client that asks for more than
   * this does not get told: a relay over its limit answers the surplus queries
   * with an empty `EOSE`, which reads exactly like a timeline with nothing in
   * it. Nothing but a positive whole number counts, and a missing figure leaves
   * the client on its own default.
   */
  maxSubscriptions?: number;
  /** NIPs the relay declares, as written in the document. */
  supportedNips: string[];
}

/** HTTP address that serves a relay's information document. */
export function relayInfoUrl(wsUrl: string): string | null {
  const match = /^(wss?):\/\/([^/\s]+)(\/\S*)?$/.exec(wsUrl.trim());
  if (match === null) return null;
  const [, scheme, host, path] = match;
  const http = scheme === "wss" ? "https" : "http";
  return `${http}://${host}${path ?? ""}`.replace(/\/+$/, "");
}

/**
 * Parse the JSON body of a NIP-11 document. Unknown fields are ignored and a
 * malformed body yields null rather than a half-filled record.
 */
export function parseRelayInfoDocument(raw: unknown): RelayInformation | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const doc = raw as Record<string, unknown>;
  const str = (key: string): string | undefined => {
    const value = doc[key];
    return typeof value === "string" && value !== "" ? value : undefined;
  };
  // Read as a number, and read as a number written as one. `supported_nips`
  // already had to take both forms — relays write the two spellings mixed in
  // the same list — and the counts sat next to it taking only one, so a relay
  // that wrote `"relay_count": "5"` lost the figure for no reason a reader can
  // see. The string has to be the whole value: `"5 relays"` is not a number,
  // and reading it as one would put a figure on screen that the document never
  // claimed.
  const num = (key: string): number | undefined => {
    const value = doc[key];
    if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
    if (typeof value !== "string") return undefined;
    const text = value.trim();
    return /^-?\d+$/.test(text) ? Number(text) : undefined;
  };
  const obj = (key: string): Record<string, unknown> | undefined => {
    const value = doc[key];
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  };
  return {
    ...present("name", str("name")),
    ...present("description", str("description")),
    ...present("icon", str("icon")),
    ...present("pubkey", str("pubkey")),
    ...present("contact", str("contact")),
    ...present("software", str("software")),
    ...present("version", str("version")),
    ...present("limitation", obj("limitation")),
    ...present("retention", obj("retention")),
    ...present("relayCount", num("relay_count")),
    ...present("listeners", num("listeners")),
    ...present(
      "maxSubscriptions",
      subscriptionLimit(obj("limitation")?.["max_subscriptions"]),
    ),
    // Relays write these as integers or as strings, sometimes mixed.
    supportedNips: Array.isArray(doc.supported_nips)
      ? doc.supported_nips
          .map((nip) =>
            typeof nip === "number" && Number.isInteger(nip)
              ? String(nip)
              : typeof nip === "string"
                ? nip.trim()
                : "",
          )
          .filter((nip) => nip !== "")
      : [],
  };
}

/**
 * `limitation.max_subscriptions` as a number of open subscriptions, or
 * undefined when the document does not state one.
 *
 * Both spellings a relay is known to write are accepted, for the same reason
 * `relay_count` is read from a string too: the figure sits next to fields the
 * parser already tolerates in either form, and one that is only read as a
 * number leaves the client asking for more than the relay serves — the one
 * mistake here that costs queries, quietly.
 */
function subscriptionLimit(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isInteger(value) && value > 0 ? value : undefined;
  }
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return /^\d+$/.test(text) && Number(text) > 0 ? Number(text) : undefined;
}

function present<K extends string, V>(
  key: K,
  value: V | undefined,
): Record<K, V> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

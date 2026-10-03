import {
  bytesToHex,
  sha256,
  signBlossomAuth,
  signHttpAuth,
} from "dacci-nostr-nips";
import { getSigner, useAuth } from "./auth.js";
import type { UploadServer } from "./servers.js";

/** Why an upload did not finish, so the form can say which it was. */
export type UploadFailure =
  | "no-signer"
  /** The reader dismissed the signature prompt, so nothing was signed. */
  | "cancelled"
  | "network"
  /** The server was reached but did not answer in the time allowed. */
  | "timeout"
  | "too-large"
  | "unsupported-type"
  | "rejected"
  | "unknown";

export type UploadResult =
  | { url: string }
  | { failure: UploadFailure; message?: string };

/** The form's own timeout; a server that never answers must not hang it. */
const TIMEOUT_MS = 60000;

/**
 * A listed server speaks one of two dialects, and which one it speaks decides
 * the whole request. The list event the server came from does not say: a NIP-96
 * server and a Blossom server are listed the same way, and the same host can
 * be both.
 *
 * - NIP-96 posts multipart form data to the `api_url` the document names.
 * - BUD-02, the current Blossom spec, takes a raw body with `PUT /upload`
 *   and answers with a blob descriptor whose `url` is the file's address.
 *
 * A server that publishes `api_url` is taken at its word, and one that does
 * not is treated as a BUD-02 server, which is what a plain host runs.
 */
interface ServerInfo {
  /** Upload endpoint, and the method the server expects on it. */
  endpoint: string;
  method: "POST" | "PUT";
  /** Where a stored file is read from, when it differs from the endpoint. */
  downloadUrl: string;
  /** The types the server accepts, or null when it does not say. */
  contentTypes: string[] | null;
}

/**
 * Reads what a server says about itself. The document is optional for a
 * BUD-02 server, so a host that serves none is not an error; only a document
 * that exists and cannot be used is.
 */
/**
 * A document's own address, or the same address resolved against the server
 * that served the document. Only a relative path is rewritten: an address the
 * server wrote in full is used exactly as written, because normalising it would
 * append a slash to a bare origin and turn a working `download_url` into a
 * different one.
 *
 * Resolving a relative path here is what keeps the bytes — and the
 * `Authorization` header that authorises them — going to the server the reader
 * picked. Left relative, `fetch` would resolve it against the app's own origin
 * and post the reader's file to whoever hosts this page.
 */
function absoluteOrResolved(address: string, server: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(address)) return address;
  try {
    return new URL(address, `${server}/`).toString();
  } catch {
    return address;
  }
}

/** How many well-known documents one upload may chase across hosts. */
const MAX_DELEGATION_HOPS = 2;

async function serverInfo(
  server: string,
  seen: Set<string> = new Set(),
  hops = 0,
): Promise<ServerInfo> {  const wellKnown = `${server}/.well-known/nostr/nip96.json`;
  let record: {
    api_url?: unknown;
    download_url?: unknown;
    delegated_to_url?: unknown;
    supported_nips?: unknown;
    content_types?: unknown;
  } = {};
  try {
    const response = await fetch(wellKnown, {
      headers: { Accept: "application/json" },
      // One of two independent deadlines: this one for the document, another
      // for the upload itself below. A host that completes the handshake and
      // then says nothing would otherwise leave the reader watching a spinner
      // with no way forward and no error.
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.ok && servesItself(response.url, server)) {
      const body: unknown = await response.json();
      if (typeof body === "object" && body !== null) {
        record = body as typeof record;
      }
    }
  } catch {
    // No document is fine: the server is then addressed as BUD-02.
  }
  const api = record.api_url;
  if (typeof api === "string" && api !== "") {
    // A document may give the endpoint as a path on itself. Resolving it against
    // the server is what keeps the bytes — and the Authorization header that
    // authorises them — going to the server the reader picked. Left relative,
    // `fetch` would resolve it against the app's own origin and post the
    // reader's file to whoever hosts this page.
    const endpoint = absoluteOrResolved(api, server);
    return {
      endpoint,
      method: "POST",
      downloadUrl:
        typeof record.download_url === "string" && record.download_url !== ""
          ? absoluteOrResolved(record.download_url, server)
          : endpoint,
      // A signature is sent either way: NIP-96 marks the upload AUTH required,
      // and a plan that also accepts an unsigned one (`is_nip98_required:
      // false`) still takes a signed one.
      contentTypes: readContentTypes(record.content_types),
    };
  }
  // A relay may serve a document of its own that only points at someone
  // else's file server. The api_url is empty in that case, so the upload has
  // to be asked of the host the relay named instead.
  const delegated = record.delegated_to_url;
  if (typeof delegated === "string" && delegated !== "" && !seen.has(delegated)) {
    // Chased at most this far. NIP-96 documents `delegated_to_url` for a relay
    // pointing at one file server, not for servers pointing at each other, so
    // no legitimate chain is longer — and every hop holds the picker another
    // minute. Past the cap the host at hand is addressed as BUD-02, the same
    // fallback a document-less host gets below.
    if (hops >= MAX_DELEGATION_HOPS) return bud02(server);
    seen.add(server);
    return serverInfo(delegated.replace(/\/+$/, ""), seen, hops + 1);
  }
  return bud02(server);
}

/**
 * BUD-02: the upload lives at /upload on the host itself. The document says
 * nothing about which types are taken, so nothing is refused up front.
 */
function bud02(server: string): ServerInfo {
  return {
    endpoint: `${server}/upload`,
    method: "PUT",
    downloadUrl: server,
    contentTypes: null,
  };
}

/**
 * True when the document came from the host it describes.
 *
 * A host that redirects its well-known elsewhere is not making a statement
 * about itself, it is pointing at somebody else's file server, and taking that
 * as its own API would post the file to a host the reader never chose. Such a
 * host is a plain Blossom one. A host that means to delegate says so with
 * NIP-96's own `delegated_to_url`, which is followed instead.
 */
function servesItself(responseUrl: string, server: string): boolean {
  try {
    return new URL(responseUrl).origin === new URL(server).origin;
  } catch {
    return false;
  }
}

/** The `content_types` a NIP-96 document lists, or null when it lists none. */
function readContentTypes(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const types = value.filter(
    (entry): entry is string => typeof entry === "string" && entry !== "",
  );
  return types.length > 0 ? types : null;
}

/**
 * True when the server says it takes a file of this type. A list entry may
 * end in `/*`, as `image/*` does, so the family is honoured.
 */
export function acceptsType(contentTypes: string[] | null, type: string): boolean {
  if (contentTypes === null || type === "") return true;
  return contentTypes.some((allowed) => {
    if (allowed === type || allowed === "*/*") return true;
    if (!allowed.endsWith("/*")) return false;
    return type.startsWith(`${allowed.slice(0, -1)}`);
  });
}

/**
 * The signed header a request needs.
 *
 * `null` when no signer is available, `"cancelled"` when the reader dismissed
 * the signature prompt, and `"invalid-endpoint"` when the address the server
 * list carried is not an address. That last one is separate from `cancelled`
 * because a reader who never saw a prompt has not cancelled one.
 */
async function authorization(
  info: ServerInfo,
  endpoint: string,
  digest: Uint8Array,
): Promise<string | null | "cancelled" | "invalid-endpoint"> {
  const signer = getSigner();
  if (signer === null) return null;
  const pubkey = useAuth().pubkey();
  if (pubkey === null) return null;
  const sign = (template: Parameters<typeof signer.signEvent>[0]) =>
    signer.signEvent(template);
  // Read before signing, not after. `new URL` throws on an address that is not
  // one, and it used to throw from inside the block whose `catch` answers
  // "cancelled" — so a server row holding something that is not an address told
  // the reader they had dismissed a signing prompt they were never shown. A
  // server list can carry such an address (it is read off the wire), so this was
  // reachable rather than theoretical.
  let blossomServer: string | null = null;
  if (info.method === "PUT") {
    try {
      // BUD-11: the `server` tag "MUST be a lowercase domain name only", not a
      // full URL — and `host` keeps a non-default port, which fails the
      // server's exact match. A port-less host reads the same either way, which
      // is why the tests never caught it.
      blossomServer = new URL(endpoint).hostname.toLowerCase();
    } catch {
      return "invalid-endpoint";
    }
  }
  // Signing refuses as a matter of course: a NIP-07 extension asks the reader
  // to confirm and throws when the dialog is dismissed. Left uncaught that
  // rejection would escape the upload with nothing said about it, and the
  // reader would only see the spinner stop.
  try {
    if (info.method === "PUT") {
      // BUD-11 validates its own event shape, so a NIP-98 header is refused.
      // The token names the action and the blob, both of which the server
      // checks against the request it received. A host that also serves NIP-96
      // is signed for whichever endpoint the file is actually posted to, since
      // the method decides which of the two dialects is in play.
      const auth = await signBlossomAuth({
        verb: "upload",
        pubkey,
        hashHex: bytesToHex(digest),
        server: blossomServer ?? "",
        content: "Upload Blob",
        signEvent: sign,
      });
      return auth.header;
    }
    // NIP-98 binds the header to the request; the payload is the hash of the
    // file, so a server can tell whether it stored the bytes meant for it.
    const auth = await signHttpAuth({
      method: "POST",
      url: endpoint,
      pubkey,
      payload: digest,
      signEvent: sign,
    });
    return auth.header;
  } catch {
    return "cancelled";
  }
}

/** The file address from a BUD-02 blob descriptor, or null. */
function urlFromDescriptor(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const url = (body as { url?: unknown }).url;
  return typeof url === "string" && url.startsWith("http") ? url : null;
}

/**
 * What a NIP-96 answer says: where the file is, or why the server said no.
 *
 * The refusal and the silence have to be told apart, and both used to arrive as
 * the same `null`. NIP-96 answers a refusal with `"status": "error"` inside a
 * body the HTTP status calls a success, and the caller below has a fallback that
 * *builds* a url from the download base — for a server that stored the file and
 * reported none. Reading an error as that silence handed the reader a link to a
 * file that was never written, in a post, under "投稿しました".
 *
 * NIP-96: `"status": "success"` … `"error"` if not.
 */
function nip96Answer(body: unknown): {
  url: string | null;
  error: string | null;
} {
  if (typeof body !== "object" || body === null) {
    return { url: null, error: null };
  }
  const record = body as { status?: unknown; message?: unknown; nip94_event?: unknown };
  if (record.status !== "success" && record.status !== undefined) {
    const said = typeof record.message === "string" ? record.message : "";
    return {
      url: null,
      // The server's own words where it gave any, since the reader is being told
      // why their file was not taken and the server is the only one who knows.
      error: said === "" ? "サーバーがアップロードを拒否しました" : said,
    };
  }
  const event = record.nip94_event;
  if (typeof event !== "object" || event === null) {
    return { url: null, error: null };
  }
  const tags = (event as { tags?: unknown }).tags;
  if (!Array.isArray(tags)) return { url: null, error: null };
  for (const tag of tags) {
    if (Array.isArray(tag) && tag[0] === "url" && typeof tag[1] === "string") {
      return { url: tag[1], error: null };
    }
  }
  return { url: null, error: null };
}

/** What a server says when it refuses, in the reader's words. */
function refusalText(status: number): string | null {
  if (status === 401) return "このサーバーは署名つきアップロードが必要です";
  // Forbidden by server policy (BUD-02), or not allowed / hash mismatch
  // (NIP-96) — neither means the signature itself was refused, so neither
  // says so. The previous wording blamed the signature for every 403.
  if (status === 403) return "サーバーがアップロードを許可しませんでした";
  if (status === 409) return "アップロード内容がハッシュと一致しません";
  if (status === 415) return "このサーバーはそのファイル形式を受け付けません";
  return null;
}

/** True for the abort a deadline raises, as opposed to a transport fault. */
function isTimeout(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    ((error as { name?: unknown }).name === "TimeoutError" ||
      (error as { name?: unknown }).name === "AbortError")
  );
}

/**
 * True when the request never reached the server.
 *
 * A fetch that never finishes its preflight fails with a TypeError, and a
 * transport fault fails the same way. `fetch` rejects with nothing else —
 * only `TypeError` for the request failing and `AbortError` for the deadline
 * — so excluding the deadline leaves the request-failed case, and a
 * cross-origin refusal is its likeliest member. It is not proven: DNS, an
 * offline reader and a refused connection fail the same way, and the message
 * below says CORS because that is the one the reader can act on by picking a
 * different server, not because the others were ruled out.
 *
 * A deadline is not that. The server was reached and simply did not answer
 * within the time allowed, which happens to a busy or half-open host, and
 * telling the reader their upload was refused for CORS sends them looking for a
 * problem they do not have.
 */
function isBrowserRefusal(error: unknown): boolean {
  return !isTimeout(error);
}

/**
 * Uploads one file and returns the url to put in a post.
 *
 * The server is asked what it speaks, and the request follows: multipart to a
 * NIP-96 `api_url`, or a raw body with `PUT /upload` for a BUD-02 host. Both
 * need the request signed, so there is no unsigned path.
 */
export async function uploadFile(
  server: UploadServer,
  file: File,
): Promise<UploadResult> {
  // Read once: the digest below and the PUT body further down shared this read,
  // so a large file sat in memory twice.
  const bytes = new Uint8Array(await file.arrayBuffer());
  const digest = sha256(bytes);

  let info: ServerInfo;
  try {
    info = await serverInfo(server.url);
  } catch (error) {
    return {
      failure: "network",
      message: error instanceof Error ? error.message : "サーバーに接続できません",
    };
  }
  // A NIP-96 document names the types it takes, so a file it would refuse is
  // caught here rather than after the bytes have crossed the network.
  if (!acceptsType(info.contentTypes, file.type)) {
    return { failure: "unsupported-type" };
  }

  const headers: Record<string, string> = {};
  let body: BodyInit;
  if (info.method === "PUT") {
    // BUD-02 takes the bytes themselves, not a form.
    headers["Content-Type"] = file.type === "" ? "application/octet-stream" : file.type;
    headers["X-SHA-256"] = bytesToHex(digest);
    body = bytes;
  } else {
    const form = new FormData();
    form.append("file", file);
    form.append("size", String(file.size));
    if (file.type !== "") form.append("content_type", file.type);
    body = form;
  }

  const auth = await authorization(info, info.endpoint, digest);
  if (auth === "cancelled") return { failure: "cancelled" };
  // The server list is read off the wire, so an entry in it can be something that
  // is not an address at all. Saying so is the only thing the reader can act on:
  // they have to take the row out of their list, and "you cancelled the signature"
  // points at a prompt they never saw.
  if (auth === "invalid-endpoint") {
    return { failure: "network", message: "サーバーの住所が正しくありません" };
  }
  // A server that wants a signature cannot be used without one, and saying so
  // is more useful than a bare rejection the reader cannot act on.
  if (auth === null) return { failure: "no-signer" };
  headers.Authorization = auth;

  let response: Response;
  try {
    response = await fetch(info.endpoint, {
      method: info.method,
      headers,
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    return isBrowserRefusal(error)
      ? {
          failure: "network",
          message: "サーバーがこのoriginからのアップロードを受け付けません (CORS)",
        }
      : { failure: "timeout" };
  }

  if (response.status === 413) return { failure: "too-large" };
  if (!response.ok) {
    const refusal = refusalText(response.status);
    return refusal === null
      ? { failure: "rejected" }
      : { failure: "rejected", message: refusal };
  }

  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  const answer =
    info.method === "PUT"
      ? { url: urlFromDescriptor(parsed), error: null }
      : nip96Answer(parsed);
  // A server that said no is not a server that stored the file. Reaching here
  // with an error meant building a url from the download base for an upload that
  // never happened.
  if (answer.error !== null) return { failure: "rejected", message: answer.error };
  const extension = extensionFor(file);
  if (answer.url !== null) return { url: withExtension(answer.url, extension) };
  // A server that stored the file but reported no url can still be linked:
  // the file is addressed by its own hash on the download base, which both
  // NIP-96 and BUD-02 serve.
  return {
    url: withExtension(`${info.downloadUrl}/${bytesToHex(digest)}`, extension),
  };
}

/**
 * The extension a file's type implies. BUD-02 asks every descriptor url to
 * carry one, so a reader pasting the link has a browser that can tell what
 * the file is; a server that omits it leaves the client to supply it.
 */
function extensionFor(file: File): string {
  // The name is the better source when the browser did not fill in a type,
  // which is the usual case for an image picked from a file manager.
  const fromName = /\.([a-z0-9]{1,8})$/i.exec(file.name)?.[1];
  if (fromName !== undefined) return `.${fromName.toLowerCase()}`;
  const fromType = EXTENSION_BY_TYPE[file.type];
  return fromType ?? "";
}

/** Adds an extension to a url that names a blob with no usable one. */
function withExtension(url: string, extension: string): string {
  if (extension === "") return url;
  // A url with a query or a fragment already says which resource it names.
  if (/[?#]/.test(url)) return url;
  const last = url.slice(url.lastIndexOf("/") + 1);
  // A blob is named by its hash. When the url carries no extension, or the
  // server used the generic `.bin`, it has told the client nothing about the
  // type and the local file's extension is a better guess than none — a link a
  // browser cannot type is no use.
  const named = /^([0-9a-f]{64})(\.[a-z0-9]{1,8})?$/i.exec(last);
  if (named === null) return url;
  // An extension the server wrote is one the server chose, and it is kept.
  // NIP-96's delayed processing asks for exactly this: "if the file processing
  // would change a file from 'jpg' to 'webp', use '.webp' extension on the
  // `nip94_event.tags.*.url` field value". Rewriting that to the uploaded file's
  // `.jpg` names a resource the server never advertised, so the link 404s.
  const advertised = named[2];
  if (advertised !== undefined && advertised.toLowerCase() !== ".bin") return url;
  return `${url.slice(0, url.length - last.length)}${named[1]}${extension}`;
}

/** The common types, so a file without a name still gets an extension. */
const EXTENSION_BY_TYPE: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/avif": ".avif",
  "image/svg+xml": ".svg",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "audio/ogg": ".ogg",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
};

/** Message for a failure the form shows under the input. */
export function uploadFailureText(failure: UploadFailure): string {
  switch (failure) {
    case "no-signer":
      return "アップロードにはログインが必要です (Settings)";
    case "cancelled":
      return "署名をキャンセルしました";
    case "network":
      return "サーバーに接続できませんでした";
    case "timeout":
      return "サーバーが時間内に応答しませんでした";
    case "too-large":
      return "ファイルが大きすぎます";
    case "unsupported-type":
      return "この形式はアップロードできません";
    case "rejected":
      return "サーバーがアップロードを拒否しました";
    case "unknown":
      return "アップロードに失敗しました";
  }
}

/** True when the file is something the app will try to upload. */
export function isUploadableFile(file: File): boolean {
  return file.size > 0;
}

/** Exported for tests: the hash a NIP-98 payload carries. */
export function fileHashHex(file: File): Promise<string> {
  return file
    .arrayBuffer()
    .then((buf) => bytesToHex(sha256(new Uint8Array(buf))));
}

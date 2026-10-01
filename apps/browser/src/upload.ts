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
  | "network"
  | "too-large"
  | "unsupported-type"
  | "rejected"
  | "no-url"
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
  /** True when the request must carry a signature. */
  authRequired: boolean;
  /** The types the server accepts, or null when it does not say. */
  contentTypes: string[] | null;
}

/**
 * Reads what a server says about itself. The document is optional for a
 * BUD-02 server, so a host that serves none is not an error; only a document
 * that exists and cannot be used is.
 */
async function serverInfo(server: string, seen: Set<string> = new Set()): Promise<ServerInfo> {
  const wellKnown = `${server}/.well-known/nostr/nip96.json`;
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
    return {
      endpoint: api,
      method: "POST",
      downloadUrl:
        typeof record.download_url === "string" && record.download_url !== ""
          ? record.download_url
          : api,
      // NIP-96 marks the upload AUTH required. A plan may also accept an
      // unsigned one (`is_nip98_required: false`), but signing still works
      // there, so a signature is sent either way.
      authRequired: true,
      contentTypes: readContentTypes(record.content_types),
    };
  }
  // A relay may serve a document of its own that only points at someone
  // else's file server. The api_url is empty in that case, so the upload has
  // to be asked of the host the relay named instead.
  const delegated = record.delegated_to_url;
  if (typeof delegated === "string" && delegated !== "" && !seen.has(delegated)) {
    seen.add(server);
    return serverInfo(delegated.replace(/\/+$/, ""), seen);
  }
  // BUD-02: the upload lives at /upload on the host itself. The document says
  // nothing about which types are taken, so nothing is refused up front.
  return {
    endpoint: `${server}/upload`,
    method: "PUT",
    downloadUrl: server,
    authRequired: true,
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

/** The signed header a request needs, or null when no signer is available. */
async function authorization(
  info: ServerInfo,
  endpoint: string,
  digest: Uint8Array,
): Promise<string | null> {
  const signer = getSigner();
  if (signer === null) return null;
  const pubkey = useAuth().pubkey();
  if (pubkey === null) return null;
  const sign = (template: Parameters<typeof signer.signEvent>[0]) =>
    signer.signEvent(template);
  if (info.method === "PUT") {
    // BUD-11 validates its own event shape, so a NIP-98 header is refused.
    // The token names the action and the blob, both of which the server
    // checks against the request it received. A host that also serves NIP-96
    // is signed for whichever endpoint the file is actually posted to, since
    // the method decides which of the two dialects is in play.
    const host = new URL(endpoint).host;
    const auth = await signBlossomAuth({
      verb: "upload",
      pubkey,
      hashHex: bytesToHex(digest),
      server: host,
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
}

/** The file address from a BUD-02 blob descriptor, or null. */
function urlFromDescriptor(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const url = (body as { url?: unknown }).url;
  return typeof url === "string" && url.startsWith("http") ? url : null;
}

/** The download url from a NIP-96 response, or null when it carries none. */
function urlFromNip96(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const status = (body as { status?: unknown }).status;
  if (status !== "success" && status !== undefined) return null;
  const event = (body as { nip94_event?: unknown }).nip94_event;
  if (typeof event !== "object" || event === null) return null;
  const tags = (event as { tags?: unknown }).tags;
  if (!Array.isArray(tags)) return null;
  for (const tag of tags) {
    if (Array.isArray(tag) && tag[0] === "url" && typeof tag[1] === "string") {
      return tag[1];
    }
  }
  return null;
}

/** What a server says when it refuses, in the reader's words. */
function refusalText(status: number): string | null {
  if (status === 401) return "このサーバーは署名つきアップロードが必要です";
  if (status === 403) return "サーバーが署名を拒否しました";
  if (status === 409) return "アップロード内容がハッシュと一致しません";
  if (status === 415) return "このサーバーはそのファイル形式を受け付けません";
  return null;
}

/** True when the browser refused the request rather than the server. */
function isBrowserRefusal(error: unknown): boolean {
  // A fetch that never completes its preflight throws a TypeError here, and
  // a transport fault does too; either way the request never reached the
  // server, so the cross-origin refusal is the likeliest cause and the one
  // the reader can act on by picking a different server.
  void error;
  return true;
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
  const digest = sha256(new Uint8Array(await file.arrayBuffer()));

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
    body = await file.arrayBuffer();
  } else {
    const form = new FormData();
    form.append("file", file);
    form.append("size", String(file.size));
    if (file.type !== "") form.append("content_type", file.type);
    body = form;
  }

  const auth = await authorization(info, info.endpoint, digest);
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
      : { failure: "network" };
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
  const url =
    info.method === "PUT" ? urlFromDescriptor(parsed) : urlFromNip96(parsed);
  const extension = extensionFor(file);
  if (url !== null) return { url: withExtension(url, extension) };
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
  // A blob is named by its hash, and a server that stored the file under a
  // generic `.bin` has told the client nothing about the type. Both cases
  // are rewritten, since a link a browser cannot type is no use.
  const named = /^([0-9a-f]{64})(\.[a-z0-9]{1,8})?$/i.exec(last);
  if (named === null) return url;
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
    case "network":
      return "サーバーに接続できませんでした";
    case "too-large":
      return "ファイルが大きすぎます";
    case "unsupported-type":
      return "この形式はアップロードできません";
    case "rejected":
      return "サーバーがアップロードを拒否しました";
    case "no-url":
      return "サーバーの応答にURLが含まれていませんでした";
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

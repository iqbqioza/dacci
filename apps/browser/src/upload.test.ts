import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isUploadableFile,
  type UploadFailure,
  uploadFailureText,
  uploadFile,
} from "./upload.js";

const HOST = "https://blossom.example";
const NIP96 = "https://nip96.example";

function file(name = "shot.png", type = "image/png", size = 8): File {
  return new File([new Uint8Array(size)], name, { type });
}

/** A signer that stamps whatever it is given, enough for the header. */
const SIGNED = () => ({
  getSigner: () => ({
    signEvent: async (template: unknown) => ({
      ...(template as Record<string, unknown>),
      id: "d".repeat(64),
      sig: "e".repeat(128),
    }),
  }),
  useAuth: () => ({ pubkey: () => "a".repeat(64) }),
});

/** No session at all, for the case that must ask the reader to sign in. */
const UNSIGNED = () => ({
  getSigner: () => null,
  useAuth: () => ({ pubkey: () => null }),
});

interface Call {
  url: string;
  init?: RequestInit;
}

/**
 * A reply to the well-known request. It carries the url the document was
 * served from, which is what says whether the host described itself or pointed
 * somewhere else; a hand-made Response cannot be given one.
 */
function document(body: unknown, servedFrom: string): Response {
  return {
    ok: true,
    url: servedFrom,
    json: async () => body,
  } as unknown as Response;
}

/** A fetch that answers the well-known document, then the upload. */
function stubFetch(options: {
  /** The document the host serves, or null for none. */
  document?: Record<string, unknown> | null;
  /**
   * Where the document was served from, when it was not the host that was
   * asked. A host that redirects its well-known elsewhere is described this
   * way, since a redirect is not a document of its own.
   */
  documentFrom?: string;
  status?: number;
  body?: unknown;
  /** What the stubbed fetch rejects with, for the upload request itself. */
  throwOn?: "wellknown" | "upload";
  /** Reject with a deadline instead of a transport fault. */
  timeoutOn?: "wellknown" | "upload";
  /**
   * A document per well-known host, for delegation chains. Hosts not named
   * here fall back to `document`.
   */
  byHost?: Record<string, Record<string, unknown> | null>;
}) {
  const calls: Call[] = [];
  const deadline = (what: "wellknown" | "upload"): Error => {
    // What `AbortSignal.timeout` raises, and what a fetch abort rejects with.
    const error = new Error("The operation was aborted due to timeout");
    error.name = "TimeoutError";
    void what;
    return error;
  };
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (options.throwOn === "upload") throw new TypeError("Failed to fetch");
    if (options.timeoutOn === "upload") throw deadline("upload");
    if (url.includes(".well-known")) {
      if (options.throwOn === "wellknown") throw new TypeError("Failed to fetch");
      if (options.timeoutOn === "wellknown") throw deadline("wellknown");
      if (options.byHost !== undefined) {
        const entry = options.byHost[new URL(url).host];
        if (entry !== undefined) {
          if (entry === null) return new Response("", { status: 404 });
          return document(entry, url);
        }
      }
      if (options.document === null) return new Response("", { status: 404 });
      return document(
        options.document ?? {},
        options.documentFrom ?? url,
      );
    }
    return new Response(
      typeof options.body === "string"
        ? options.body
        : JSON.stringify(options.body ?? {}),
      { status: options.status ?? 200 },
    );
  });
  return calls;
}

beforeEach(() => {
  vi.resetModules();
  // A Blossom server requires the header, so most cases run signed in.
  vi.doMock("./auth.js", SIGNED);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("./auth.js");
});

describe("Blossom upload", () => {
  it("uses PUT /upload with a raw body when there is no document", async () => {
    const calls = stubFetch({
      document: null,
      body: { url: "https://blossom.example/abc.png", sha256: "abc" },
    });
    const { uploadFile: upload, fileHashHex: hash } = await import("./upload.js");
    const target = file();
    const result = await upload({ url: HOST }, target);

    // BUD-02 puts the upload at /upload and takes the bytes themselves.
    expect(calls[1].url).toBe(`${HOST}/upload`);
    expect(calls[1].init?.method).toBe("PUT");
    // The file's own bytes, read once: the digest above and this body shared
    // one read, so a large file no longer sits in memory twice.
    const sent = calls[1].init?.body;
    expect(sent).toBeInstanceOf(Uint8Array);
    expect([...(sent as Uint8Array)]).toEqual([...new Uint8Array(await target.arrayBuffer())]);
    // The hash is offered so the server can check the bytes it received.
    const headers = calls[1].init?.headers as Record<string, string>;
    expect(headers["X-SHA-256"]).toBe(await hash(target));
    expect(headers["Content-Type"]).toBe("image/png");
    expect(result).toEqual({ url: "https://blossom.example/abc.png" });
  });

  it("signs a BUD-02 request for the exact endpoint it authorises", async () => {
    const calls = stubFetch({ document: null, body: { url: "https://x.example/a.png" } });
    const { uploadFile: upload } = await import("./upload.js");
    await upload({ url: HOST }, file());
    const headers = calls[1].init?.headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^Nostr /);
  });

  it("posts multipart to the api_url a document names", async () => {
    const calls = stubFetch({
      document: { api_url: `${NIP96}/upload`, supported_nips: [96, 98] },
      body: {
        status: "success",
        nip94_event: { tags: [["url", "https://media.example/a.png"]] },
      },
    });
    const { uploadFile: upload } = await import("./upload.js");
    const result = await upload({ url: NIP96 }, file());

    // A NIP-96 server is addressed at the url it published, by POST.
    expect(calls[1].url).toBe(`${NIP96}/upload`);
    expect(calls[1].init?.method).toBe("POST");
    expect(calls[1].init?.body).toBeInstanceOf(FormData);
    expect(result).toEqual({ url: "https://media.example/a.png" });
  });

  it("resolves a relative endpoint against the server, not against the app", async () => {
    // A document may name its endpoint as a path on itself. Left relative,
    // `fetch` resolves it against the page, so the reader's file — and the
    // Authorization header that authorises it — would be posted to whoever hosts
    // this app instead of to the server they chose.
    const calls = stubFetch({
      document: { api_url: "/api", supported_nips: [96, 98] },
      body: { status: "success", nip94_event: { tags: [["url", "https://media.example/a.png"]] } },
    });
    const { uploadFile: upload } = await import("./upload.js");
    await upload({ url: NIP96 }, file());
    expect(calls[1].url).toBe(`${NIP96}/api`);
  });

  it("falls back to the download base when no url comes back", async () => {
    stubFetch({ document: null, body: { uploaded: 1 } });
    const { uploadFile: upload, fileHashHex: hash } = await import("./upload.js");
    const target = file();
    // The file is addressed by its own hash, so the link still resolves.
    const result = await upload({ url: HOST }, target);
    expect(result).toEqual({ url: `${HOST}/${await hash(target)}.png` });
  });

  it("uses the download url a document names for the link", async () => {
    stubFetch({
      document: {
        api_url: `${NIP96}/api`,
        download_url: "https://media.example",
        supported_nips: [96, 98],
      },
      body: { status: "success" },
    });
    const { uploadFile: upload, fileHashHex: hash } = await import("./upload.js");
    const target = file();
    const result = await upload({ url: NIP96 }, target);
    expect(result).toEqual({
      url: `https://media.example/${await hash(target)}.png`,
    });
  });

  it("treats a document that is not JSON as no document", async () => {
    const calls = stubFetch({ document: null, body: { url: "https://x.example/a.png" } });
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes(".well-known")) return new Response("<html>", { status: 200 });
      return new Response(JSON.stringify({ url: "https://x.example/a.png" }), {
        status: 200,
      });
    });
    const { uploadFile: upload } = await import("./upload.js");
    const result = await upload({ url: HOST }, file());
    // A host serving HTML at the well-known path still works as Blossom.
    expect(calls[1].url).toBe(`${HOST}/upload`);
    expect(result).toEqual({ url: "https://x.example/a.png" });
  });
});

describe("uploadFile", () => {
  it("sends the file, its size and its type as NIP-96 asks", async () => {
    const calls = stubFetch({
      document: { api_url: `${NIP96}/upload` },
      body: { status: "success", nip94_event: { tags: [["url", "https://x.example/a.png"]] } },
    });
    const { uploadFile: upload } = await import("./upload.js");
    await upload({ url: NIP96 }, file("shot.png", "image/png", 8));
    const form = calls[1].init?.body as FormData;
    expect([...form.keys()].sort()).toEqual(["content_type", "file", "size"]);
    expect(form.get("size")).toBe("8");
    expect(form.get("content_type")).toBe("image/png");
    expect((form.get("file") as File).name).toBe("shot.png");
  });

  it("does not invent a url for a NIP-96 server that said no", async () => {
    // NIP-96 refuses in the body, inside a response the HTTP status calls a
    // success. That used to be read the same as a server which stored the file
    // and reported no url — for which the caller builds one from the download
    // base — so a refused upload produced a link to a file that was never
    // written, in the post, under a success message.
    const calls = stubFetch({
      document: { api_url: `${NIP96}/upload` },
      body: { status: "error", message: "Payment required" },
    });
    const { uploadFile: upload } = await import("./upload.js");
    const result = await upload({ url: NIP96 }, file("shot.png", "image/png", 8));
    expect(result).toEqual({ failure: "rejected", message: "Payment required" });
    // The upload really was sent, so this is a refusal rather than a fault in
    // reaching the server: the test would pass for the wrong reason otherwise.
    expect(calls.length).toBe(2);

    // An error with no message of its own is still a refusal, not a silence.
    stubFetch({
      document: { api_url: `${NIP96}/upload` },
      body: { status: "error" },
    });
    const bare = await upload({ url: NIP96 }, file("shot.png", "image/png", 8));
    expect(bare).toMatchObject({ failure: "rejected" });
    expect((bare as { message?: string }).message).not.toBe("");

    // And the silence is still a silence: a server that stored the file and
    // reported no url can be linked by its own hash, which is the case the
    // fallback exists for and must keep working.
    const silent = stubFetch({
      document: { api_url: `${NIP96}/upload` },
      body: { status: "success", nip94_event: { tags: [] } },
    });
    expect(await upload({ url: NIP96 }, file("shot.png", "image/png", 8))).toEqual(
      { url: expect.stringContaining(NIP96) },
    );
    expect(silent.length).toBe(2);
  });

  it.each([
    [413, "too-large"],
    [415, "unsupported-type"],
  ])("maps status %i to %s", async (status, failure) => {
    stubFetch({ status, body: {} });
    const { uploadFile: upload } = await import("./upload.js");
    const result = await upload({ url: HOST }, file());
    if (failure === "too-large") {
      expect(result).toEqual({ failure: "too-large" });
    } else {
      expect(result).toMatchObject({ failure: "rejected" });
      expect((result as { message?: string }).message).toContain("形式");
    }
  });

  it("reports a rejected upload", async () => {
    stubFetch({ status: 400, body: {} });
    const { uploadFile: upload } = await import("./upload.js");
    const result = await upload({ url: HOST }, file());
    expect(result).toEqual({ failure: "rejected" });
  });

  it("reports a network fault on the upload itself", async () => {
    stubFetch({ throwOn: "upload" });
    const { uploadFile: upload } = await import("./upload.js");
    const result = await upload({ url: HOST }, file());
    expect(result).toMatchObject({ failure: "network" });
  });

  it("names CORS when the server refuses a cross-origin post", async () => {
    // In a browser a fetch that never finishes its preflight fails here,
    // which is almost always the server refusing cross-origin uploads.
    stubFetch({ throwOn: "upload" });
    const { uploadFile: upload } = await import("./upload.js");
    const result = await upload({ url: HOST }, file());
    expect((result as { message?: string }).message).toContain("CORS");
  });

  it("tells a server that stopped answering from one that refused the origin", async () => {
    // A deadline is not a cross-origin refusal. The server was reached and did
    // not answer in the time allowed — a busy or half-open host — and telling
    // the reader their upload was refused for CORS sends them looking for a
    // problem they do not have, on a server that would have worked.
    stubFetch({ timeoutOn: "upload" });
    const { uploadFile: upload } = await import("./upload.js");
    const result = await upload({ url: HOST }, file());
    expect(result).toEqual({ failure: "timeout" });
    const { uploadFailureText } = await import("./upload.js");
    expect(uploadFailureText("timeout")).not.toContain("CORS");
  });

  it("refuses a server that needs a signature when there is none", async () => {
    vi.doMock("./auth.js", UNSIGNED);
    stubFetch({ status: 401, body: {} });
    const { uploadFile: upload } = await import("./upload.js");
    const result = await upload({ url: HOST }, file());
    expect(result).toEqual({ failure: "no-signer" });
  });

  it("reports a dismissed signature prompt instead of rejecting", async () => {
    // A NIP-07 extension asks the reader to confirm and throws when the dialog
    // is dismissed. That is ordinary, not a crash, and it must come back as a
    // reason: left uncaught it escapes through a `void` and the reader is left
    // watching a spinner with nothing said.
    vi.doMock("./auth.js", () => ({
      getSigner: () => ({
        signEvent: async () => {
          throw new Error("user rejected");
        },
      }),
      useAuth: () => ({ pubkey: () => "a".repeat(64) }),
    }));
    stubFetch({ status: 200, body: {} });
    const { uploadFile: upload } = await import("./upload.js");
    const result = await upload({ url: HOST }, file());
    expect(result).toEqual({ failure: "cancelled" });
  });

  it("explains a 401 from a server that wants a signature", async () => {
    stubFetch({ status: 401, body: {} });
    const { uploadFile: upload } = await import("./upload.js");
    const result = await upload({ url: HOST }, file());
    expect(result).toMatchObject({ failure: "rejected" });
    expect((result as { message?: string }).message).toContain("署名");
  });

  it("explains a 409, which means the bytes did not match the hash", async () => {
    stubFetch({ status: 409, body: {} });
    const { uploadFile: upload } = await import("./upload.js");
    const result = await upload({ url: HOST }, file());
    expect((result as { message?: string }).message).toContain("ハッシュ");
  });

  it("links a file the server stored but named no url for", async () => {
    // The download base plus the hash is where both NIP-96 and BUD-02 serve a
    // stored file from, so a body without a url is not a dead end.
    const calls = stubFetch({ document: null, body: { uploaded: 1 } });
    const { uploadFile: upload, fileHashHex: hash } = await import("./upload.js");
    const target = file();
    const result = await upload({ url: HOST }, target);
    expect(calls[1].url).toBe(`${HOST}/upload`);
    expect(result).toEqual({ url: `${HOST}/${await hash(target)}.png` });
  });
});

describe("Blossom authorization", () => {
  /** Reads the event back out of the header, as a server would. */
  function decode(header: string): Record<string, unknown> {
    const raw = header.replace("Nostr ", "");
    const padded = raw.replace(/-/g, "+").replace(/_/g, "/");
    const b64 = padded + "=".repeat((4 - (padded.length % 4)) % 4);
    return JSON.parse(atob(b64));
  }

  it("sends a BUD-11 token, not a NIP-98 one, to a BUD-02 server", async () => {
    // A NIP-98 header is refused outright: the kinds and the tags differ, so
    // the two dialects must not be sent interchangeably.
    const calls = stubFetch({ document: null, body: { url: "https://x.example/a.png" } });
    const { uploadFile: upload } = await import("./upload.js");
    await upload({ url: HOST }, file());
    const event = decode(
      (calls[1].init?.headers as Record<string, string>).Authorization,
    );
    expect(event.kind).toBe(24242);
  });

  it("names the action, the blob and where the token is valid", async () => {
    const calls = stubFetch({ document: null, body: { url: "https://x.example/a.png" } });
    const { uploadFile: upload, fileHashHex: hash } = await import("./upload.js");
    const target = file();
    await upload({ url: HOST }, target);
    const event = decode(
      (calls[1].init?.headers as Record<string, string>).Authorization,
    );
    const tags = event.tags as string[][];
    // BUD-11 requires each of these and the server checks them all.
    expect(tags).toContainEqual(["t", "upload"]);
    expect(tags).toContainEqual(["x", await hash(target)]);
    expect(tags).toContainEqual(["server", "blossom.example"]);
    const expiration = tags.find((t) => t[0] === "expiration");
    expect(Number(expiration?.[1])).toBeGreaterThan(event.created_at as number);
  });

  it("scopes the token to the bare domain, without a port", async () => {
    // BUD-11: the `server` tag "MUST be a lowercase domain name only", and the
    // server exact-matches it. `URL.host` keeps a non-default port, so an
    // upload to `https://blossom.example:8443` carried
    // `["server", "blossom.example:8443"]` and failed validation server-side.
    const calls = stubFetch({
      document: null,
      body: { url: "https://x.example/a.png" },
    });
    const { uploadFile: upload } = await import("./upload.js");
    await upload({ url: "https://blossom.example:8443" }, file());
    const event = decode(
      (calls[1].init?.headers as Record<string, string>).Authorization,
    );
    expect((event.tags as string[][])).toContainEqual([
      "server",
      "blossom.example",
    ]);
  });

  it("sends a NIP-98 header to a server that publishes a NIP-96 api_url", async () => {
    const calls = stubFetch({
      document: { api_url: `${NIP96}/upload`, supported_nips: [96, 98] },
      body: { status: "success", nip94_event: { tags: [["url", "https://x.example/a.png"]] } },
    });
    const { uploadFile: upload } = await import("./upload.js");
    await upload({ url: NIP96 }, file());
    const event = decode(
      (calls[1].init?.headers as Record<string, string>).Authorization,
    );
    expect(event.kind).toBe(27235);
  });

  it("uses base64url without padding, as BUD-11 asks", async () => {
    const calls = stubFetch({ document: null, body: { url: "https://x.example/a.png" } });
    const { uploadFile: upload } = await import("./upload.js");
    await upload({ url: HOST }, file());
    const header = (calls[1].init?.headers as Record<string, string>).Authorization;
    const token = header.replace("Nostr ", "");
    expect(token).not.toContain("+");
    expect(token).not.toContain("/");
    expect(token).not.toContain("=");
  });

  it("signs a NIP-96 upload even when the document omits 98", async () => {
    // NIP-96 marks the upload AUTH required. A document that leaves 98 out of
    // its list has not said the upload is free, so it is still signed.
    const calls = stubFetch({
      document: { api_url: `${NIP96}/upload`, supported_nips: [96] },
      body: { status: "success", nip94_event: { tags: [["url", "https://x.example/a.png"]] } },
    });
    const { uploadFile: upload } = await import("./upload.js");
    await upload({ url: NIP96 }, file());
    const header = (calls[1].init?.headers as Record<string, string>).Authorization;
    expect(decode(header).kind).toBe(27235);
  });
});

describe("the server's own document", () => {
  it("ignores a document another host served, and asks the host itself", async () => {
    // A host that redirects its well-known elsewhere is pointing at somebody
    // else's file server, not describing its own API. Taking that as its own
    // would post the file to a host the reader never chose, so the host is
    // asked at its own /upload instead.
    const calls = stubFetch({
      document: { api_url: "https://elsewhere.example/upload" },
      documentFrom: "https://elsewhere.example/.well-known/nostr/nip96.json",
      body: { url: "https://x.example/a.png" },
    });
    const { uploadFile: upload } = await import("./upload.js");
    const result = await upload({ url: HOST }, file());
    expect(result).toEqual({ url: "https://x.example/a.png" });
    expect(calls[1].url).toBe(`${HOST}/upload`);
    expect(calls[1].init?.method).toBe("PUT");
  });

  it("asks the host a relay pointed at, when the relay hosts no uploader", async () => {
    // A relay may serve a document of its own that only names someone else's
    // file server. The api_url is empty there, so the upload has to be asked
    // of the host it names.
    const calls: Call[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.startsWith(HOST)) {
        return document({ api_url: "", delegated_to_url: `${NIP96}/` }, url);
      }
      if (url.includes(".well-known")) {
        return document({ api_url: `${NIP96}/upload` }, url);
      }
      return new Response(
        JSON.stringify({
          status: "success",
          nip94_event: { tags: [["url", "https://x.example/a.png"]] },
        }),
        { status: 200 },
      );
    });
    const { uploadFile: upload } = await import("./upload.js");
    const result = await upload({ url: HOST }, file());
    expect(result).toEqual({ url: "https://x.example/a.png" });
    // The delegated host is asked, not the relay.
    expect(calls.map((call) => call.url)).toEqual([
      `${HOST}/.well-known/nostr/nip96.json`,
      `${NIP96}/.well-known/nostr/nip96.json`,
      `${NIP96}/upload`,
    ]);
  });

  it("stops chasing a delegation chain and uploads as BUD-02", async () => {
    // NIP-96 documents `delegated_to_url` for a relay pointing at one file
    // server, not for servers pointing at each other. Chasing a longer chain
    // holds the picker a minute per hop, so past the cap the host at hand is
    // addressed as BUD-02 instead.
    const chain = (host: string, next: string): Record<string, unknown> => ({
      api_url: "",
      delegated_to_url: `https://${next}/`,
    });
    const calls = stubFetch({
      byHost: {
        "h0.example": chain("h0.example", "h1.example"),
        "h1.example": chain("h1.example", "h2.example"),
        "h2.example": chain("h2.example", "h3.example"),
        "h3.example": chain("h3.example", "h4.example"),
      },
      body: { url: "https://h2.example/abc.png", sha256: "abc" },
    });
    const { uploadFile: upload } = await import("./upload.js");
    const result = await upload({ url: "https://h0.example" }, file());
    // Three documents chased (the start plus two hops), then BUD-02 on the
    // host whose document delegated too far — not two more minutes per hop.
    expect(calls.filter((call) => call.url.includes(".well-known"))).toHaveLength(3);
    expect(calls.at(-1)?.url).toBe("https://h2.example/upload");
    expect(result).toEqual({ url: "https://h2.example/abc.png" });
  });

  it("refuses a type the document does not list, without sending the file", async () => {
    // The document names what it takes, so a file it would reject is caught
    // here rather than after the bytes have crossed the network.
    const calls = stubFetch({
      document: { api_url: `${NIP96}/upload`, content_types: ["image/*"] },
      body: { status: "success", nip94_event: { tags: [["url", "https://x.example/a.png"]] } },
    });
    const { uploadFile: upload } = await import("./upload.js");
    const result = await upload({ url: NIP96 }, file("a.pdf", "application/pdf"));
    expect(result).toEqual({ failure: "unsupported-type" });
    expect(calls).toHaveLength(1);
  });

  it.each([
    [["image/png"], "image/png", true],
    [["image/*"], "image/png", true],
    [["image/*"], "application/pdf", false],
    [["audio/mpeg", "image/png"], "image/png", true],
    [["video/mp4"], "image/png", false],
  ])("reads %j against %s as %s", async (types, type, allowed) => {
    const { acceptsType } = await import("./upload.js");
    expect(acceptsType(types, type)).toBe(allowed);
  });

  it("accepts anything when the document lists no types", async () => {
    const { acceptsType } = await import("./upload.js");
    expect(acceptsType(null, "application/pdf")).toBe(true);
  });
});

describe("file extension", () => {
  it("adds the extension the file name implies", async () => {
    // BUD-02 asks every descriptor url to carry one, and a server that
    // omits it leaves the client to supply it.
    const hash = "84e3dd1b98cef3829b3237371d0d40d0675ef5229bdf1618e57cc47064ae7a2f";
    const calls = stubFetch({ document: null, body: { url: `${HOST}/${hash}` } });
    const { uploadFile: upload } = await import("./upload.js");
    const result = await upload({ url: HOST }, file("shot.png"));
    expect(result).toEqual({ url: `${HOST}/${hash}.png` });
    expect(calls).toHaveLength(2);
  });

  it("keeps the extension a server chose, which may not be the file's", async () => {
    // NIP-96's delayed processing: "if the file processing would change a file
    // from 'jpg' to 'webp', use '.webp' extension on the `nip94_event.tags.*.url`
    // field value." A client that rewrote that to the uploaded file's `.jpg`
    // named a resource the server never advertised, so the link 404s.
    stubFetch({
      document: { api_url: `${NIP96}/upload` },
      body: {
        status: "success",
        nip94_event: {
          tags: [["url", `https://nip96.example/${"9".repeat(64)}.webp`]],
        },
      },
    });
    const { uploadFile: upload } = await import("./upload.js");
    const result = await upload(
      { url: NIP96 },
      file("photo.jpg", "image/jpeg", 8),
    );
    expect(result).toEqual({
      url: `https://nip96.example/${"9".repeat(64)}.webp`,
    });
  });

  it("leaves a url that already ends in an extension alone", async () => {
    const hash = "a".repeat(64);
    stubFetch({ document: null, body: { url: `${HOST}/${hash}.png` } });
    const { uploadFile: upload } = await import("./upload.js");
    const result = await upload({ url: HOST }, file("shot.png"));
    expect(result).toEqual({ url: `${HOST}/${hash}.png` });
  });

  it("replaces a generic .bin with the real extension", async () => {
    // The hash still identifies the blob, so only the type in the name is
    // wrong and replacing it keeps the link working.
    const hash = "84e3dd1b98cef3829b3237371d0d40d0675ef5229bdf1618e57cc47064ae7a2f";
    stubFetch({ document: null, body: { url: `${HOST}/${hash}.bin` } });
    const { uploadFile: upload } = await import("./upload.js");
    const result = await upload({ url: HOST }, file("shot.png"));
    expect(result).toEqual({ url: `${HOST}/${hash}.png` });
  });

  it("falls back to the file type when the name has no extension", async () => {
    const hash = "b".repeat(64);
    stubFetch({ document: null, body: { url: `${HOST}/${hash}` } });
    const { uploadFile: upload } = await import("./upload.js");
    const result = await upload({ url: HOST }, file("noext", "image/jpeg"));
    expect(result).toEqual({ url: `${HOST}/${hash}.jpg` });
  });

  it("adds nothing for a type it does not know", async () => {
    const hash = "c".repeat(64);
    stubFetch({ document: null, body: { url: `${HOST}/${hash}` } });
    const { uploadFile: upload } = await import("./upload.js");
    const result = await upload(
      { url: HOST },
      file("blob", "application/x-unknown"),
    );
    expect(result).toEqual({ url: `${HOST}/${hash}` });
  });

  it("does not rewrite a url that carries a query or a fragment", async () => {
    const hash = "d".repeat(64);
    stubFetch({ document: null, body: { url: `${HOST}/${hash}?w=32` } });
    const { uploadFile: upload } = await import("./upload.js");
    const result = await upload({ url: HOST }, file("shot.png"));
    expect(result).toEqual({ url: `${HOST}/${hash}?w=32` });
  });
});

describe("uploadFailureText", () => {
  it("does not tell a reader they cancelled a prompt they never saw", async () => {
    // The server list is read off the wire, so a row in it can hold something
    // that is not an address. `new URL` threw on it from inside the block whose
    // `catch` answers "cancelled", so the reader was told they had dismissed a
    // signing prompt — a prompt that never appeared, on a server they cannot
    // upload to either way.
    stubFetch({ document: { accepts: ["*/*"] } });
    const { uploadFile: upload } = await import("./upload.js");
    const result = await upload(
      { url: "not-a-url" },
      file("shot.png", "image/png", 8),
    );
    expect(result).toMatchObject({ failure: "network" });
    expect((result as { message?: string }).message).toContain("住所");
    expect((result as { failure?: string }).failure).not.toBe("cancelled");
  });

  it("has a message for every failure", () => {
    // Every member of the union, so adding a failure without wording it fails
    // here rather than shipping a blank line under the input. `satisfies`
    // keeps the list honest in the other direction too: removing a member
    // without touching this list is a type error, not a silent shrink.
    const reasons = [
      "no-signer",
      "cancelled",
      "network",
      "timeout",
      "too-large",
      "unsupported-type",
      "rejected",
      "unknown",
    ] as const;
    const all: readonly UploadFailure[] = reasons;
    expect(all).toHaveLength(8);
    for (const reason of reasons) {
      expect(uploadFailureText(reason).length).toBeGreaterThan(0);
    }
  });
});

describe("upload bytes", () => {
  it("reads the file once for both the digest and the body", async () => {
    stubFetch({ document: null, body: { url: "https://x.example/a.png" } });
    const { uploadFile: upload } = await import("./upload.js");
    const target = file();
    let reads = 0;
    const original = target.arrayBuffer.bind(target);
    vi.spyOn(target, "arrayBuffer").mockImplementation(async () => {
      reads += 1;
      return original();
    });
    await upload({ url: HOST }, target);
    // The digest and the PUT body shared one read; a large file no longer
    // sits in memory twice.
    expect(reads).toBe(1);
  });
});

describe("isUploadableFile", () => {
  it("accepts a file with bytes and refuses an empty one", () => {
    expect(isUploadableFile(file("a.png", "image/png", 4))).toBe(true);
    expect(isUploadableFile(file("a.png", "image/png", 0))).toBe(false);
  });
});

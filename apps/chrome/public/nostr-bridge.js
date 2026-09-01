(() => {
  if (window.nostr) {
    return;
  }

  let requestId = 0;
  const pending = new Map();

  window.addEventListener("message", (event) => {
    if (event.source !== window) {
      return;
    }
    const data = event.data;
    if (data?.type !== "nostr:response") {
      return;
    }
    const entry = pending.get(data.requestId);
    if (!entry) {
      return;
    }
    pending.delete(data.requestId);
    if (data.ok) {
      entry.resolve(data.result);
    } else {
      entry.reject(new Error(data.error));
    }
  });

  function call(method, ...args) {
    const id = String(++requestId);
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      window.postMessage({ type: "nostr:request", requestId: id, method, args }, "*");
    });
  }

  window.nostr = {
    getPublicKey: () => call("getPublicKey"),
    signEvent: (event) => call("signEvent", event),
    getRelays: () => call("getRelays"),
    nip04: {
      encrypt: (pubkey, plaintext) => call("nip04.encrypt", pubkey, plaintext),
      decrypt: (pubkey, ciphertext) => call("nip04.decrypt", pubkey, ciphertext),
    },
    nip44: {
      encrypt: (pubkey, plaintext) => call("nip44.encrypt", pubkey, plaintext),
      decrypt: (pubkey, ciphertext) => call("nip44.decrypt", pubkey, ciphertext),
    },
  };
})();
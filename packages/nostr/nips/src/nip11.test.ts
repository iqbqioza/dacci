import { describe, expect, it } from "vitest";
import { parseRelayInfoDocument, relayInfoUrl } from "./nip11.js";

describe("relayInfoUrl", () => {
  it("maps a secure relay to its https address", () => {
    expect(relayInfoUrl("wss://relay.example")).toBe("https://relay.example");
    expect(relayInfoUrl("wss://relay.example/")).toBe("https://relay.example");
    expect(relayInfoUrl("wss://relay.example/nostr/")).toBe(
      "https://relay.example/nostr",
    );
  });

  it("keeps plain ws on http", () => {
    expect(relayInfoUrl("ws://127.0.0.1:7777")).toBe("http://127.0.0.1:7777");
  });

  it("refuses anything that is not a relay URL", () => {
    expect(relayInfoUrl("https://relay.example")).toBeNull();
    expect(relayInfoUrl("relay.example")).toBeNull();
  });
});

describe("parseRelayInfoDocument", () => {
  it("reads a complete NIP-11 document", () => {
    // Field list as nostrfy.org and damus.io actually return it.
    const info = parseRelayInfoDocument({
      name: "Example relay",
      description: "A relay",
      pubkey: "a".repeat(64),
      contact: "mailto:admin@example.com",
      supported_nips: ["1", "11", "42"],
      software: "strfry",
      version: "1.8.0",
      limitation: { max_message_length: 16384 },
      retention: { kinds: [0, 1], time: 3600 },
      relay_count: 42,
      listeners: 7,
    });
    expect(info?.name).toBe("Example relay");
    expect(info?.description).toBe("A relay");
    expect(info?.software).toBe("strfry");
    expect(info?.version).toBe("1.8.0");
    expect(info?.relayCount).toBe(42);
    expect(info?.listeners).toBe(7);
    expect(info?.supportedNips).toEqual(["1", "11", "42"]);
    expect(info?.limitation?.max_message_length).toBe(16384);
  });

  it("accepts NIPs written as numbers, strings or a mix", () => {
    // Relays in the wild send integers, strings, or both in one array.
    expect(
      parseRelayInfoDocument({ supported_nips: [1, "42", 11] })?.supportedNips,
    ).toEqual(["1", "42", "11"]);
    expect(
      parseRelayInfoDocument({ supported_nips: [1, 2.5, null, "", "9"] })
        ?.supportedNips,
    ).toEqual(["1", "9"]);
  });

  it("reads the icon and the relay's own limits", () => {
    const info = parseRelayInfoDocument({
      icon: "https://relay.example/logo.png",
      limitation: { max_message_length: 1048576, auth_required: true },
    });
    expect(info?.icon).toBe("https://relay.example/logo.png");
    expect(info?.limitation?.max_message_length).toBe(1048576);
    expect(info?.limitation?.auth_required).toBe(true);
  });

  it("reports missing fields as absent, not empty strings", () => {
    const info = parseRelayInfoDocument({ name: "", supported_nips: [] });
    expect(info?.name).toBeUndefined();
    expect(info?.description).toBeUndefined();
    expect(info?.supportedNips).toEqual([]);
  });

  it("rejects bodies that are not relay documents", () => {
    expect(parseRelayInfoDocument(null)).toBeNull();
    expect(parseRelayInfoDocument("<html>")).toBeNull();
    expect(parseRelayInfoDocument([1, 2, 3])).toBeNull();
  });
});

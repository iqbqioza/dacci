# Security Policy

## Reporting a Vulnerability

Please **do not** open a public issue for security problems. Report them privately so they can be fixed before they are disclosed.

**How to report:**

1. **Preferred:** use the GitHub private vulnerability reporting form:
   https://github.com/iqbqioza/dacci/security/advisories/new
2. **Alternatively:** email the maintainer at **takuya@iqbqioza.com** with the subject
   prefixed with **`[SECURITY-REPORT:dacci]`** (e.g.
   `[SECURITY-REPORT:dacci] Private key exposure via the NIP-07 bridge`).

**Please include:**

- The affected version (from the extension manifest)
- The browser and platform (Chrome / Firefox / Safari, OS)
- A description of the vulnerability and its impact
- Steps to reproduce

## Response

This is a personal project maintained in spare time, so responses are best-effort:

- **Acknowledgement:** as soon as possible — ideally within **3 business days**.
- **Status updates:** you will be kept informed of the fix progress whenever possible.
- **Fix timeline:** depends on severity and availability — critical issues are prioritized; a fix and a security advisory are published as soon as practical.

## Scope

- The extension itself: key generation and storage, the encrypted vault, the passphrase and auto-lock logic, NIP-07 (`window.nostr`) handling, event signing confirmation, NIP-04/NIP-44 message encryption, and the panel UI.
- The build and release artifacts (the `apps/chrome` and `apps/firefox` packages, the release workflows).

Out of scope: the websites you visit, Nostr relays, and third-party libraries bundled by the underlying toolchain.

## Security Notes for Users

- Your keys never leave the extension — signing and encryption always happen inside it.
- The vault is encrypted with your passphrase; choose a strong one and keep it safe — it cannot be recovered.
- Review signing requests carefully, especially the first time a site asks for a new kind.
- Only install the extension from trusted sources (the official store listings or the GitHub release assets).
- Report vulnerabilities even for minor issues — fixes are appreciated.
<div align="center">

<img src="assets/dacci-small.png" alt="Dacci" width="240" />

# Dacci

Nostr Signer browser extension

[![CI](https://github.com/iqbqioza/dacci/actions/workflows/ci.yml/badge.svg)](https://github.com/iqbqioza/dacci/actions/workflows/ci.yml)
[![Release](https://github.com/iqbqioza/dacci/actions/workflows/release.yml/badge.svg)](https://github.com/iqbqioza/dacci/actions/workflows/release.yml)

</div>

## Features

- Manage multiple keys and switch between them
- Encrypted key storage with a passphrase
- Auto-lock after a configurable idle time
- Slide-in panel instead of a popup window
- NIP-07 (`window.nostr`) support
- Per-site event signing confirmation (host + port + kind)
- E2EE encryption and decryption (NIP-04, NIP-44)
- No telemetry. No data is sent anywhere.

## Supported Browsers

| Browser | Status |
|---------|--------|
| Chrome | Supported |
| Firefox | Supported |
| Safari | In development |

## Development

```bash
npm install
npm run build
```

### Chrome

1. Open `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked" and select `apps/chrome/dist`

### Firefox

1. Open `about:debugging#/runtime/this-firefox`
2. Click "Load Temporary Add-on…"
3. Select `apps/firefox/dist/manifest.json`

## Repo Structure

```
apps/
  chrome/     Chrome extension
  firefox/    Firefox extension
  safari/     Safari extension
packages/
  core/       Shared crypto and logic
assets/       Shared assets
```

## License

[MIT](LICENSE)
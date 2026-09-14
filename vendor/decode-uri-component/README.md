# decode-uri-component CommonJS compatibility build

Tracked by [#30](https://github.com/av-evolv/social-chat-platform/issues/30).

Expo Router 57.0.21 requires query-string 7.1.3, whose CommonJS parser calls `require('decode-uri-component')` as a function. Its decoder 0.2.2 is affected by [GHSA-vcc3-ghjq-m6fr](https://github.com/advisories/GHSA-vcc3-ghjq-m6fr). The fixed upstream 0.5.0 is ESM-only; directly overriding the dependency would give this caller an incompatible module namespace.

This directory contains the complete upstream 0.5.0 decoder, with **only the default export changed to `module.exports`** (and its closing semicolon). No decoder algorithm changes or install-time patch scripts are used. The package version `0.5.0-larynx.1` identifies this local compatibility build. The original MIT license is retained.

## Provenance

- [Upstream release](https://github.com/SamVerschueren/decode-uri-component/releases/tag/v0.5.0), [security fix](https://github.com/SamVerschueren/decode-uri-component/commit/fa479dafeede7bedf04e5c89aa78f2a78c664005).
- Source: published `decode-uri-component@0.5.0` npm tarball.
- Tarball integrity: `sha512-1BiQVoK8C9gUbQU6NzAtO/tkz2qOFpEObMWpcFvhx4fYnj4Oc5yzaJN/LD36ihkVUdXyh5ZekzX+yM+ty/SrPg==`.
- Original `index.js` SHA-256: `9401353df38f8010ad7035fe8d666bce6a4902bc1cff809afc4ab23fa2e0bdaa`.

## Maintenance

The root override is scoped to query-string 7.1.3 and references the root local development dependency with npm's `$decode-uri-component` syntax. The explicit root dependency ensures npm resolves the local directory from the workspace root; it is consumed by the client build. Local source is committed and copied into the client Docker build before `npm ci`; clean installs need no GitHub checkout or network patch download. `npm test` runs bounded malformed-input regressions and callback/query compatibility checks against Router's resolved dependency. Normal CI also exports web, iOS and Android and exercises the browser.

When upgrading Expo Router/query-string, check upstream support and remove this directory and override once Router resolves a patched, compatible decoder without them. Do not treat a clean audit as a review of vendored code: review upstream decoder advisories/releases during dependency updates and port any subsequent security changes explicitly.

# OpenMLS selection and compatibility spike

Decision date: 2026-09-14. [#3](https://github.com/av-evolv/social-chat-platform/issues/3), implementation [#10](https://github.com/av-evolv/social-chat-platform/issues/10), launch review [#20](https://github.com/av-evolv/social-chat-platform/issues/20).

Select **OpenMLS 0.9.0** as the MLS implementation for the next integration stage. Keep application/frontend/backend logic in TypeScript; isolate a small Rust cryptographic core with web WASM and native module adapters. Do not reimplement MLS in TypeScript. This selection is conditional on the integration gates below; the disposable probe is not a shipping adapter and adds no root npm dependency.

## Selection evidence

[OpenMLS](https://github.com/openmls/openmls/tree/openmls-v0.9.0) implements RFC 9420 and uses provider interfaces for cryptography, randomness and storage. Its MIT license and a shared Rust implementation allow one protocol core across frontend targets. The selected release tag resolves to `3a3e35de3feeca8f6605143c464d5452ae584d43`. The isolated crate pins OpenMLS `0.9.0`, RustCrypto/basic-credential/traits `0.6.0`, wasm-bindgen `0.2.126` and a full checksummed Cargo.lock. The fixture uses the standard mandatory suite `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`; no draft extensions, custom cipher suites or cryptographic primitives are added. OpenMLS and provider crates bring their own Rust dependencies even when an individual algorithm is unused.

The [upstream audit announcement](https://blog.openmls.tech/posts/2026-05-27-independent-audit/) and linked [SRLabs report](https://blog.openmls.tech/SRL-OpenMLS_security_assurance_assessment.pdf) establish independent review history. They do **not** certify our current provider, wrapper, persistence, UI or the entire 0.9.0 dependency graph. The announcement reported eight findings and one low-severity item still being addressed at publication. Integration review must reconcile that finding and subsequent changes; do not describe the current product as independently audited.

Choosing an older version solely because an audit mentioned it would miss later fixes. The upstream [quadratic extension decoding advisory](https://github.com/openmls/openmls/security/advisories/GHSA-w62v-gv48-63rh) and [deserializer panic advisory](https://github.com/openmls/openmls/security/advisories/GHSA-rrmv-c79f-cf5r), published 2026-08-25, identify `0.9.0` as patched. Review current advisories again before shipping; release pinning is not proof of absence of vulnerabilities. Enforce decoder input/rate limits even with patched code.

[Matrix Rust SDK](https://github.com/matrix-org/matrix-rust-sdk) offers a separate encryption state machine but brings Matrix protocol semantics into our independent audience/backend design. That is a larger product/protocol choice, so it is not selected as an incidental crypto package. [Libsodium AEAD](https://doc.libsodium.org/secret-key_cryptography/aead) supplies useful reviewed building blocks, not MLS group membership/state; it cannot replace an MLS implementation. A concrete media/backup encryption format remains a separate #15/#18 selection, rather than assembling one here.

## Reproducible probe

Source: [spikes/security/openmls](../../spikes/security/openmls). Fixture credentials are unauthenticated test labels and storage is disposable memory. No user content, keys, accounts, network delivery or database is involved.

From the repository root, with Rust 1.95.0 (tested), wasm-bindgen CLI 0.2.126 and the repository's installed Playwright dependency:

```sh
cargo test --locked --manifest-path spikes/security/openmls/Cargo.toml -- --nocapture
cargo clippy --locked --manifest-path spikes/security/openmls/Cargo.toml -- -D warnings
rustup target add wasm32-unknown-unknown aarch64-apple-ios aarch64-linux-android
cargo build --locked --release --manifest-path spikes/security/openmls/Cargo.toml --target wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.126 --locked
wasm-bindgen --target web --out-dir spikes/security/openmls/pkg spikes/security/openmls/target/wasm32-unknown-unknown/release/larynx_security_spike.wasm
node spikes/security/openmls/browser-check.cjs
cargo check --locked --manifest-path spikes/security/openmls/Cargo.toml --target aarch64-apple-ios
cargo check --locked --manifest-path spikes/security/openmls/Cargo.toml --target aarch64-linux-android
```

The browser checker opens only its own temporary loopback server on a free port and closes it after checking. `pkg` and `target` are generated/ignored. Chromium must be installed for the repository Playwright version (`npx playwright install chromium`). The wasm-bindgen **build tool's** published lockfile reported a yanked `der 0.8.0` and future-incompatibility warnings for `buf_redux`/`multipart`; these are not product or probe runtime dependencies. Use the matching CLI version and review build tooling before production packaging.

## Observed results

| Environment / check | Result | What it establishes |
| --- | --- | --- |
| macOS arm64, rustc/cargo 1.95.0, native host test | PASS | Real MLS operations through selected provider |
| Browser-target optimized WASM build and JS binding generation | PASS | Buildable WASM artifact and browser loader |
| Playwright Chromium 153.0.8010.12, WASM runtime | PASS, no page errors | Same assertions execute with actual browser randomness/WASM |
| `aarch64-apple-ios` Cargo check | PASS | Rust target type-check/compile compatibility only; no linked iOS app or device |
| `aarch64-linux-android` Cargo check | PASS | Rust target type-check/compile compatibility only; no Android NDK link or device |
| React Native 0.86 / Expo 57 / Hermes native module | NOT RUN | No RN bindings are supplied or validated here |
| Safari/WebKit, Firefox, physical browsers/devices | NOT RUN | WebKit executable unavailable locally; Chromium is not Safari/iOS evidence |

Both executed environments assert: add/Welcome join with matching epoch authenticator; rejection of pre-admission history; changed-ciphertext rejection; successful authorized decryption; replay rejection; a removed member cannot read the new epoch even before receiving the removal; after removal the member cannot send. There is one native scenario test with eight checks, not eight independent test cases. It runs only the selected cipher suite and two fixture devices.

A rejected tampered ciphertext consumed that receive generation in the in-memory provider; retransmitting its original authentic ciphertext then failed with `SecretReuseError`. The final probe deliberately uses a fresh generation for the positive decryption check. This is a material integration constraint: do not assume `process_message` errors leave state untouched. #10 must test lost/replaced frames, denial-of-service bounds, storage transaction behavior and safe resynchronization. Do not restore old ratchets ad hoc to make retries succeed.

## Integration gates

- #10: typed narrow native/WASM adapter; authenticated account/device credential binding and trust verification; secure randomness on every runtime; client-verifiable membership/role-change authority evidence independent of bare server assertions, group roster generation and state gate; full native/web wire interoperability (including persisted restarts), concurrency, duplicate/stale Welcome/Commit handling and bounded parsing. Fixture `unwrap`/panics must never become the product error boundary.
- #9/#10: encrypted durable store with per-group single writer, atomic protocol/inbox/outbox mutations and crash/rollback tests. Memory storage and basic labels are intentionally insufficient. SecureStore/SQLCipher and browser unlock/persistence must actually work on target devices.
- #14/#15/#18: reviewed versioned event envelopes, streaming media and recovery formats; no implicit audience widening; retention applies to key/history backups. MLS does not define the whole product's object encryption or backup scheme.
- #20: review the exact OpenMLS/provider/dependency/adapter graph and outstanding upstream audit findings, run current vulnerability checks, commission integration security review, and test iOS/Android/Hermes and supported web browsers. Do not advertise production E2EE from compile results or this narrow functional probe.

Upstream source and advisory URLs were checked on the decision date. A full Cargo advisory scan was not run locally (`cargo-audit` is not installed); the checked upstream advisories above are narrower evidence, with the full dependency scan a #20 gate. Root repository CI continues to cover the existing platform; the isolated Rust/browser spike is explicitly run using the commands above and is not yet part of required CI.

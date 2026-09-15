# Larynx client

One TypeScript app for web, iOS, and Android, using Expo Router and React Native primitives. The account screen supports OAuth sign-in, account details, device revocation and logout. Messaging is not implemented yet. The temporary visual treatment does not select or replace the brand explorations at the repository root.

Run from the repository root after `npm ci`:

```sh
npm run web --workspace @larynx/client
npm run ios --workspace @larynx/client
npm run android --workspace @larynx/client
npm run typecheck --workspace @larynx/client
npm run build --workspace @larynx/client
```

`build` exports the static website and both native JavaScript bundles into `dist`. A successful export verifies bundling; it does not prove an iOS or Android app binary compiles or runs on a device. `ios` and `android` require their respective native toolchains and generate local native projects through Expo. Native build and device validation is tracked in the roadmap separately.

The Dockerfile uses the repository root as its build context and serves the exported website on port 8080. It does not proxy backend requests. Account API access uses the platform’s scoped OAuth2 bearer tokens.

Keep Expo and React Native versions aligned with the Expo SDK’s bundled package metadata. Gesture Handler, Reanimated, and Worklets are explicitly pinned to SDK-compatible versions because Expo Router’s drawer dependency has broad peer requirements that otherwise allow incompatible native packages. Root overrides keep those versions consistent across the workspace dependency graph. Verify both `expo install --check` and `npm ls`; the Expo check alone does not catch incompatible transitive peers. Add storage, authentication, or inference libraries only with the corresponding feature.

## Account sign-in

Set `EXPO_PUBLIC_API_ORIGIN` before development or export (default `http://localhost:3000`). Production requires HTTPS. The value is public build configuration, not a secret. The provider must approve the web origin and exact `<web-origin>/oauth/callback` redirect for `larynx-web`, and `larynx://oauth/callback` for `larynx-native`. Both clients request `openid offline_access profile:read profile:write` with the API resource audience. Sign-in, registration, passkeys and recovery use the provider’s account pages.

Fresh state, nonce and S256 PKCE protect every authorization flow. Web stores only the pending verifier/state/nonce in sessionStorage, expires it after ten minutes and consumes it before callback exchange; authorization codes are removed from the address bar. Web access and refresh tokens remain in memory and disappear on reload. Native sign-in uses the system authentication browser, and tokens use Expo SecureStore with device-only, unlocked keychain access. This requires a native development/production build with the registered scheme, not Expo Go. Refresh requests serialize in each app instance, and logout/revocation prevents a pending refresh from restoring cleared tokens.

Before accepting a code exchange, the client sends the ID token and expected nonce to the issuer’s authenticated `/v1/session/confirm`. The issuer validates signature, issuer, audience, subject and nonce against the bearer session. This trusted-server validation is explicit; the client does not treat decoding a JWT as verification. Account/device crypto state remains pending: account recovery does not recover encrypted history.

Protocol regression tests: `node --import tsx --test apps/client/test/protocol.test.mjs` from the repository root. Browser end-to-end checks cover the actual redirects and account UI; native bundling alone does not validate device keychain/browser behavior.

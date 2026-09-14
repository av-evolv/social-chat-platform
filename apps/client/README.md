# Larynx client

One TypeScript app for web, iOS, and Android, using Expo Router and React Native primitives. This first screen is an honest foundation preview: accounts, messaging, and API requests are not implemented yet. The temporary visual treatment does not select or replace the brand explorations at the repository root.

Run from the repository root after `npm ci`:

```sh
npm run web --workspace @larynx/client
npm run ios --workspace @larynx/client
npm run android --workspace @larynx/client
npm run typecheck --workspace @larynx/client
npm run build --workspace @larynx/client
```

`build` exports the static website and both native JavaScript bundles into `dist`. A successful export verifies bundling; it does not prove an iOS or Android app binary compiles or runs on a device. `ios` and `android` require their respective native toolchains and generate local native projects through Expo. Native build and device validation is tracked in the roadmap separately.

The Dockerfile uses the repository root as its build context and serves the exported website on port 8080. It does not proxy backend requests. Future product API access must use the platform’s scoped OAuth2 tokens.

Keep Expo and React Native versions aligned with the Expo SDK’s bundled package metadata. Gesture Handler, Reanimated, and Worklets are explicitly pinned to SDK-compatible versions because Expo Router’s drawer dependency has broad peer requirements that otherwise allow incompatible native packages. Root overrides keep those versions consistent across the workspace dependency graph. Verify both `expo install --check` and `npm ls`; the Expo check alone does not catch incompatible transitive peers. Do not add storage, authentication, or inference libraries until the corresponding feature is implemented.

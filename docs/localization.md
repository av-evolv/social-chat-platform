# Languages and presentation

[#42](https://github.com/av-evolv/social-chat-platform/issues/42) provides English (`en`) and French (`fr`) for the shared Expo web/iOS/Android app, issuer account/consent pages and transactional email. Regional variants such as `fr-CA` select French; unsupported preferences fall back to English. User-authored messages, device names, application identifiers and canonical API values are never translated.

## Shared catalogs

`packages/i18n` supplies i18next JSON v4 messages with fully qualified keys, named `{{value}}` interpolation and locale plural suffixes. Client, issuer and shared session messages live in separate English/French catalog pairs. Translate whole messages instead of concatenating sentences. Add the same keys and placeholders in both languages; plural families include all supported locale categories. The package tests enforce parity, fallback, interpolation and plural behavior.

The server selects a fixed translator per request; it never changes a process-global language. Translations return plain text. React renders text safely; server HTML must escape the translated result and interpolated user values. No raw backend or passkey-library error message should reach a user-facing surface. API error codes remain stable for client translation.

Use the package’s `formatDate` and `formatNumber` helpers with the selected locale. Preserve ISO timestamps and numeric values in APIs. Event interfaces must provide their event timezone explicitly when formatting; localization must not alter event timing. All frontend platforms use the same catalogs. Native system passkey dialogs remain controlled by the operating system.

## Preference and transport

A shared, accessible English/Français selector changes the app language. Browser/device preferences provide the initial language; an explicit device preference is retained under `larynx.locale` in localStorage on web and SecureStore on native. Browser rendering starts in English to match static HTML, then resolves the language after hydration and updates the document language. Native app language detection uses expo-localization.

Accounts have an optional saved locale. The profile read exposes it, and `POST /v1/account/locale` accepts only `en` or `fr` under `profile:write` with current OAuth/account/session checks. The app restores this preference when loading the account and saves signed-in selector changes. An in-flight profile read cannot overwrite a newer language selection. Storage or preference failures do not bypass authentication or persist credentials.

The app sends `ui_locales` during OIDC authorization and `Accept-Language` with API requests. Issuer pages preserve locale through signup, passkeys, recovery and consent without changing OAuth state/nonce, CSRF, redirect validation or approved scopes. Issuer language selection is presentation metadata, never proof of account ownership. Signup records the selected locale; existing accounts retain their preference unless explicitly changed. Transactional mail uses a known recipient preference where available, otherwise the initiating/request language and English fallback. API responses do not reveal whether the recipient has an account or a saved preference.

## Verification and future surfaces

The test suite checks English/French catalogs, regional and unsupported preference handling, interpolation escaping boundaries, plural counts, date/number formatting and profile authorization. Browser journeys cover English and French signup, consent, recovery, invitation/proof email, acceptance, language persistence and mobile layout. CI also exports web, iOS and Android; physical device and operating-system passkey checks remain part of [#20](https://github.com/av-evolv/social-chat-platform/issues/20).

Future features must add translated messages, accessibility labels and locale-aware formatting in the same issue. Automatic translation of user content is separate product scope. Source references: [i18next JSON format](https://www.i18next.com/misc/json-format), [i18next plurals](https://www.i18next.com/translation-function/plurals), and [Expo localization](https://docs.expo.dev/guides/localization/).

# A1 design: persistent in-app assistants (LUMI in Dancer, ARIA in Business)

Status: design + groundwork, 2026-11-21. Scope is **A1 only**: UI and architecture behind default-OFF flags. Not authorized and not built here: any AI endpoint call, AI SDK, API key, conversation table or SQL, provider spend, billing, unrestricted actions. The responder is a local deterministic stub behind an interface; A2 (server) plugs in later and must not start before the AI usage/entitlement architecture investigation lands.

## 1. Two assistants, one engine

LUMI (Dancer app, `com.idanceflow.student`) is dancer-facing: discovery, learning, events, personal progress. ARIA (Business app, `com.idanceflow.business`) is studio operations with governed next actions. They are **distinct assistants** that share infrastructure. Identity is data in a per-assistant `AssistantConfig` (`mobile/shared/assistant/types.ts`): name, avatar initials/asset, tone, intro and disclaimer text, capability list, allowed screen contexts, allowed deep-link targets, suggested-prompt provider and flag key. The engine never contains the strings "LUMI" or "ARIA".

## 2. How to share code between two apps with no shared package

Facts checked in the tree: neither app has a `metro.config.js` (both use Expo's default), `tsconfig` extends `expo/tsconfig.base` with `@/*` -> `./src/*`, jest is `jest-expo` with `rootDir` = the app and `moduleNameMapper` `@/`. Both apps depend on the same React 19.1.0 / RN 0.81.5 / Expo ~54.0.37. `package.json`, `package-lock.json`, `app.json`, `app.config.*` and `eas.json` are CODEOWNERS-protected (owner approval).

| Option | What it needs | Release-build impact with flags off | Risk |
|---|---|---|---|
| (a) shared source folder `mobile/shared/` via Metro `watchFolders`/alias | NEW `metro.config.js` in both apps, tsconfig `paths`/`include`, jest `moduleNameMapper` + `roots`, and `nodeModulesPaths` so files outside the app resolve `react`/`react-native` | Both release builds change (new Metro config, wider watch set). Shared files resolve imports by walking up from `mobile/shared/`, i.e. toward the repo root where the WEB app's `node_modules` lives: a second copy of React is the classic failure (invalid hook call) | High: touches the config both QA/release scripts (`Build-ReleaseAab`, `build-*.sh`) depend on; failure appears only at runtime |
| (b) per-app copies of one source + parity test | Nothing outside `src/`. Source of truth `mobile/shared/assistant/`; `node mobile/shared/sync-assistant.js` writes byte-identical copies to `src/assistant/shared/` in each app; a jest parity test in each app fails on any drift, stale or hand-edited file | Only new files under `src/`. No config, native or dependency change | Low: drift is caught by CI; cost is two committed copies |
| (c) workspace package | root/app `package.json` + lockfile changes, npm workspaces or `file:` dep, Metro symlink resolution (`unstable_enableSymlinks`), EAS install behavior changes | Both lockfiles and install trees change | Highest: protected files, lockfile churn, EAS/Gradle install semantics |

**Recommendation: (b).** It is the only option that leaves both release builds' configuration byte-for-byte unchanged. The tradeoff is duplicated files, mitigated by the single source, the sync script (`--check` mode for CI use) and the parity test.

Shared (source in `mobile/shared/assistant/`, copied): types and config contract, message reducer/state, provider and hooks, stub responder, screen-context sanitizer, deep-link resolver, and the UI components, which take an `AssistantTheme` token object instead of importing an app theme. Per app (never shared): the assistant config (LUMI/ARIA identity), screen specs and prompt providers, deep-link specs, theme adapter (Dancer `colorsForScheme`, Business `palette`), flag read, mount point in the root layout, and screen registrations.

**Bundle honesty.** With flags off, the assistant modules are still part of the JS bundle if they are statically imported (Metro includes static `require`s; the Business flag is parsed from a runtime list, so it cannot be constant-folded). So "byte-for-byte unchanged" holds for the build configuration, native projects, versions, dependencies and every default-path screen, but NOT for the JS bundle byte count (a few tens of KB). What the flag guarantees is behavior: nothing renders, no provider state, no listeners, no storage read, no network, no native work, proven by tests. To keep evaluation off the default path the mount point loads the engine with a lazy `require` inside the flag branch.

## 3. Engine (PR 2)

- Message model, reducer with `send`, `retry`, `cancel`, `clear`; ids from a counter + time (no crypto dependency).
- Conversation continuity across navigation: the provider lives above the navigator, so route changes do not unmount it; closing or minimizing the sheet keeps the thread.
- **Persistence decision: in-memory only by default.** An optional `ConversationStore` interface exists (explicit, clearable, session-scoped, no screen context persisted) but no app wires one in A1. Everything is dropped on sign-out and on user switch (the provider is keyed by user id, as `StaffSessionProvider` is today).
- Responder: `respond(request, {signal, timeoutMs})` async and cancellable; errors are typed (`AssistantError.kind`: timeout, network, unavailable, rate_limited, refused, unknown). Out-of-order/aborted replies are discarded. Deterministic stub: canned replies keyed on the screen id and keywords, optional delay and forced-failure hooks for tests. It performs no I/O.

## 4. Screen context contract (PR 3)

A screen registers a minimal descriptor `{ screenId, entityIds? }` through `useAssistantScreen(...)`: ids from the assistant's allow-list only; entity values must match their declared shape (`uuid` or `slug`). Never names, emails, amounts, notes, free text or dates. The sanitizer drops unknown screens, unknown keys and malformed values. Initial screens: Dancer: `today`, `event-detail`, `wallet`, `events-list` (plus schedule); Business: `today`, `client-detail`, `appointment-detail`, `pulse`, `clients`.

**Server contract (A2).** The client context is a hint for relevance only. The server must (1) authenticate the caller, (2) re-authorize every id against that caller (studio membership/role for Business, ownership/linkage for Dancer) before reading any data, (3) ignore context it cannot authorize rather than echo it, (4) never grant a capability because the context claims a screen, and (5) validate returned link targets against the same whitelist; the client re-validates anyway.

## 5. Deep links (PR 3)

The responder returns `{target, params, label}`, never a path. `resolveLink(config, link)` looks `target` up in the config's whitelist, requires each param to match its declared shape (`uuid` strict regex as in `notificationRoute.ts`; `slug` `^[a-z0-9-]{1,80}$`), builds the href from the template and returns it; anything else is rejected and rendered as plain text (the label). Templates are tested against the real route files so a renamed route cannot silently dangle. Dancer targets: event detail, events list, wallet, schedule. Business targets: appointment detail, client detail, Today, Pulse, Clients (read destinations only; no write route is a target).

## 6. UI (PR 4)

Floating launcher (min 44 dp, `accessibilityRole=button`, label "Open <name> assistant", hint), safe-area aware, offset above bottom tabs, shown only on normal authenticated screens (hidden on sign-in/auth callback/loading, modals, when the keyboard is up, and while another sheet is open). Conversation sheet with a full-screen toggle: message list, composer, typing indicator, error + Retry, empty state with contextual suggestions, `KeyboardAvoidingView` pattern reused from the Business fix (#736). Honors font scale 2.0 (no fixed heights holding text, no `numberOfLines`) and dark mode via theme tokens. Static a11y audit per app via the existing `auditA11y` utilities.

## 7. Flags

Business: new word `ariaAssistant` in `EXPO_PUBLIC_STAFF_FEATURES`, default OFF, not in any default build config; not a write feature, not in `Test-StaffFeatures` gates. Dancer: new word `lumiAssistant` in a new `EXPO_PUBLIC_DANCER_FEATURES` list, default OFF, AND the existing server `access.lumiEnabled`. The existing `app/lumi.tsx` screen is untouched.

## 8. A2 interface note

A2 supplies an `AssistantResponder` implementation (server-backed, streaming optional) and nothing else changes in the apps. Assumptions A2 must honor: request shape `AssistantRequest` (no client-side secrets, bounded history, sanitized context), typed `AssistantError` kinds including `rate_limited` (entitlement/usage limits from the separate architecture investigation), server-side re-authorization of all ids, link targets limited to the whitelist, and no write actions in A1 or until a governed-action design exists.

## 9. What was verified vs assumed

See the PR body for the evidence of each PR (jest runs, tsc, a11y audits). Assumed, not verified: behavior on real devices (no device slot used), EAS builds, and Metro bundle size delta.

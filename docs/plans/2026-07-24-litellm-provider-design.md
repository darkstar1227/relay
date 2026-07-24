# LiteLLM provider support — design

## Problem

`relay` today only manages one kind of identity: subscription accounts, switched by overwriting the OAuth credential store Claude Code reads (macOS Keychain service `Claude Code-credentials`, or `~/.claude/.credentials.json` on Linux). There's no way to route Claude Code through a LiteLLM proxy — a separate mechanism entirely, based on environment variables (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL`) rather than credential-store contents — so users who want to supplement subscription usage with other model providers (via LiteLLM) currently have to hand-roll shell aliases outside relay entirely.

Goal: let relay manage LiteLLM-backed providers with the same first-class add/list/switch UX it already gives subscription accounts, while keeping the two mechanisms cleanly separated (they write to different places and don't interfere with each other).

## Confirmed facts (verified against official docs + a live local test — see Verification below)

- Claude Code's `~/.claude/settings.json` `env` block is read at startup **and reloads live on file change** — no restart needed for `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` (only `model`/`outputStyle` need a restart).
- Precedence: **settings.json `env` block beats shell-exported env vars** of the same name. This means a naive "just `export` before launching claude" approach for a single independent session is not actually safe — a later edit to the global settings.json could override it.
- Claude Code's `--settings <json-or-file>` CLI flag is a **session-scoped override that sits above the settings.json file layer** in precedence, fixed at launch and immune to any later edit of `~/.claude/settings.json` during that session's lifetime. This is the correct mechanism for a truly independent one-off session (see `relay run`, below).
- LiteLLM auth: `ANTHROPIC_AUTH_TOKEN` is correct (not `ANTHROPIC_API_KEY`) because Claude Code sends it as `Authorization: Bearer <token>`, which is what LiteLLM's proxy master/virtual key expects.
- `ANTHROPIC_BASE_URL` for a LiteLLM proxy is the bare `http://host:port` — no `/anthropic` path suffix (that suffix is only for LiteLLM's separate raw passthrough testing endpoint, not what Claude Code itself should be pointed at).
- `ANTHROPIC_MODEL` must match a `model_name` entry in the LiteLLM proxy's `config.yaml`.
- `/model` picker won't show LiteLLM's models by default. Setting `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` makes Claude Code query the proxy's `/v1/models` at startup and populate `/model` with everything the proxy exposes (labeled "From gateway"), switchable live mid-session.

## Architecture

Two mutually exclusive **global** modes, plus one **session-scoped, fully independent** escape hatch:

1. **Subscription mode** (existing, unchanged) — `relay <account>` swaps OAuth credentials into the Keychain/credentials file. Global; affects every `claude` process on the machine going forward.
2. **Provider mode** (new) — `relay provider use <name>` merges LiteLLM-routing keys into `~/.claude/settings.json`'s `env` block. Also global, also affects every future `claude` launch, but through a completely different file (settings.json, never touches Keychain/credentials).
3. **`relay run <name>`** (new) — a one-off launch that does *not* touch either global mechanism:
   - if `<name>` is a subscription account: equivalent to `relay <name>` (global switch, same as today) followed by `exec claude`. No isolation needed here since the user confirmed true concurrent multi-subscription-account use is out of scope — Keychain is inherently a single global slot.
   - if `<name>` is a provider: `exec claude --settings '<inline JSON env block>' "$@"` — writes nothing anywhere, unaffected by (and does not affect) whatever `relay provider use/off` or `relay <account>` state exists globally or gets changed by other terminals concurrently.

Modes 1 and 2 are mutually exclusive: switching one clears the other's active marker so `relay status` always reports exactly one truth about what's globally active. Mode 3 is orthogonal to both — it's how a single terminal opts out of the global state entirely for one launch.

## Storage

`~/.claude-relay/providers/<name>.json`, chmod 600 — same convention as `~/.claude-relay/credentials/<name>.json`:

```json
{
  "base_url": "http://localhost:4000",
  "auth_token": "sk-...",
  "model": "claude-sonnet-4-5",
  "discover_models": true
}
```

`model` and `discover_models` are optional (omitted keys aren't written into settings.json's env block).

`~/.claude-relay/active_provider` — plain text, the currently-active provider name (mirrors how subscription mode tracks `current_name()`). Absent when subscription mode is active.

**Namespace collision guard:** `relay add <name>` and `relay provider add <name>` each check the *other* store for the same name and error out (`"<name>" is already a provider — pick a different account name`, and vice versa). Keeps `relay run <name>` dispatch unambiguous.

## Commands

- `relay provider add <name> --base-url <url> --token <token> [--model <model>] [--discover-models]`
  Validates `<url>` looks like a URL, writes the JSON file (chmod 600), rejects if `<name>` collides with an existing account.
- `relay provider list`
  Lists configured providers (name, base_url, model if set), marks the active one (if any) with the same `✓`/highlight convention `relay list` uses for the active account.
- `relay provider remove <name>`
  Deletes the provider file. If it was active, also runs the `off` cleanup (see below) so settings.json doesn't keep a dangling override.
- `relay provider use <name>`
  1. Read `~/.claude/settings.json` (create `{}` if absent).
  2. Merge into its `env` object: `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, and (only if set on the provider) `ANTHROPIC_MODEL`, `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1"`. All other existing keys in `env` and the rest of the file are preserved untouched (JSON read-modify-write, not blind overwrite).
  3. Write `~/.claude-relay/active_provider` = `<name>`.
  4. Print confirmation, same tone as `do_switch`'s "✓ switched → name" message.
- `relay provider off`
  1. Read `~/.claude/settings.json`, delete exactly the 4 keys above from `env` (leave everything else, including any of the user's own unrelated env entries, untouched).
  2. Delete `~/.claude-relay/active_provider`.
  3. Prints confirmation. Whatever subscription account is currently in Keychain silently resumes being "what's active" (it was never touched).
- `relay run <name> [-- <claude args...>]`
  Dispatch on which store `<name>` is found in:
  - **account:** call the same switch path `relay <name>` uses, then `exec claude "$@"`.
  - **provider:** `exec claude --settings "$(provider_settings_json <name>)" "$@"` — no global file touched.
  - **neither:** error, same message style as today's `account_exists` failure.

**Mutual exclusion enforcement:**
- `_do_switch_locked` (existing account switch path) additionally strips the 4 provider keys from `~/.claude/settings.json`'s `env` (if present) and removes `active_provider`, so a stale `ANTHROPIC_BASE_URL` can never silently keep routing a "switched back to subscription" session through the old proxy.
- `relay provider use` does not need to touch Keychain — subscription credentials sit inert there while provider mode is active; switching back to an account just works because `_do_switch_locked` already runs unconditionally on `relay <account>`.

## Status display

`relay status` / `relay quick` gain a one-line banner above the existing account table:

- Subscription mode active: unchanged (existing table, existing "current" highlight).
- Provider mode active: `⚡ litellm: <name> (<base_url>)` banner; account table still renders below it (for context/reference) but visually deprioritized since it's not what's actually routing requests right now.

## Verification performed during design

Live-tested against a minimal local HTTP server standing in for a LiteLLM proxy (`127.0.0.1:8934`), using the installed `claude` v2.1.206:

1. `claude --settings '{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:8934","ANTHROPIC_AUTH_TOKEN":"test-token-123"}}' -p "say hi"` → request hit the fake proxy at `/v1/messages` (no `/anthropic` suffix needed) with header `Authorization: Bearer test-token-123`, and the fake proxy's canned response was what `claude -p` printed back — confirms the routing and auth-header mechanics.
2. Repeated with `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` **also exported in the shell with different (wrong) values**, to simulate a conflicting global state existing concurrently — `--settings` still won outright, request still landed on the fake proxy with the correct token. Confirms `--settings` is genuinely immune to whatever else is present in the environment, which is the property `relay run <provider>`'s independence guarantee depends on.

## Edge cases

- `relay provider use <name>` where `<name>` doesn't exist → error, no file changes.
- `~/.claude/settings.json` doesn't exist yet → treated as `{}`, created fresh.
- `~/.claude/settings.json` exists but is malformed JSON → abort with a clear error before writing anything (never blind-overwrite a file relay didn't fully own).
- `relay provider remove <name>` on the currently active provider → runs `off` cleanup first, then deletes.
- `relay run <name>` where `<name>` matches neither an account nor a provider → error.
- Provider `add` with a name colliding with an existing account (or vice versa) → rejected at creation time, not at dispatch time.

## Testing plan

1. `relay provider add mylitellm --base-url http://localhost:4000 --token sk-test` → `relay provider list` shows it, unmarked as active.
2. `relay provider use mylitellm` → `~/.claude/settings.json`'s `env` has the 3-4 expected keys; `relay status` shows the `⚡ litellm:` banner; unrelated pre-existing keys in settings.json (seed the file with e.g. `{"env":{"FOO":"bar"},"model":"opus"}` first) survive untouched.
3. `relay <some-account>` → provider keys are gone from settings.json's `env`, `active_provider` file gone, account table/current highlight correct.
4. `relay provider off` while a provider is active → keys removed, subscription resumes (no Keychain write needed — verify Keychain content unchanged before/after).
5. `relay provider add samename` where `samename` is an existing account name → rejected. Same test reversed (`relay add` colliding with existing provider name).
6. `relay run mylitellm -- -p "say hi"` with the fake-proxy harness from Verification, with a *different* provider simultaneously `relay provider use`'d globally → confirm the `run` session hits the fake proxy tied to `mylitellm`'s config, not whatever's globally active.
7. `relay run <account-name>` → confirms it behaves identically to `relay <account-name>` followed by `claude`.

## Docs

- `CLAUDE.md` architecture section: add `~/.claude-relay/providers/` and `~/.claude-relay/active_provider` alongside the existing `credentials/`/`order` state-file notes, and a one-line mention that provider mode writes to `~/.claude/settings.json`'s `env` block rather than the credential store.
- `README.md`: new subsection under existing account docs covering `relay provider add/list/use/off/remove` and `relay run`, with the LiteLLM `config.yaml` minimal example from this doc.

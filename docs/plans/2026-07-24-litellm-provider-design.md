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

**Implementation note:** `relay` already defines `CLAUDE_DIR="${HOME}/.claude"` (relay:17). All references to `~/.claude/settings.json` below resolve to `${CLAUDE_DIR}/settings.json` — reuse the existing constant, don't hardcode a new literal path.

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

`~/.claude-relay/settings_env_snapshot.json`, chmod 600 — **the pre-relay original state of the 4 managed keys**, captured once the first time provider mode is ever activated from a fully-dormant state, and consumed (restored + deleted) the next time control fully hands back to subscription mode. See "Settings ownership, replacement, and concurrency" below — this file is what closes the two correctness gaps an adversarial review surfaced in the first draft of this design.

**Namespace collision guard:** `relay add <name>` and `relay provider add <name>` each check the *other* store for the same name and error out (`"<name>" is already a provider — pick a different account name`, and vice versa). Keeps `relay run <name>` dispatch unambiguous.

## Settings ownership, replacement, and concurrency

An adversarial review of the first draft of this design found three related defects, all in how `env` keys get mutated. This section is the fix; it replaces the original "merge on use / delete 4 keys on off" description.

**Problem 1 — partial replacement leaks stale keys.** If provider A sets `ANTHROPIC_MODEL`/`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` and provider B doesn't, merely *merging* B's keys on top of A's leftover `env` entries leaves B silently running with A's model/discovery settings. Fix: every activation is a **full replace of the managed key set** — unconditionally remove all 4 managed keys first, then add back only the keys the newly-activated provider actually defines.

**Problem 2 — destroying settings the user owned before relay ever touched them.** If the user already had their own `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`/etc. in `settings.json` (e.g. a personal gateway, hand-configured), relay has no way to distinguish "value I wrote" from "value the user wrote" once it starts deleting keys on `off`/account-switch. Fix: **snapshot-once, restore-on-full-exit.** The first time provider mode is activated while no snapshot exists, capture the current value (or explicit absence) of all 4 managed keys into `settings_env_snapshot.json` before touching anything. Every subsequent `provider use` (switching between providers while already in provider mode) leaves that snapshot untouched — only a full exit from provider mode (`provider off`, or switching to a subscription account) restores the snapshotted values/absences and then deletes the snapshot file. This means an A→B→C chain of provider switches, followed by `off`, restores the *original pre-relay* state, not provider B's or C's leftover state.

**Problem 3 — non-atomic writes with no shared lock.** Writing `settings.json` via a plain `open(path, "w")` can leave malformed JSON if interrupted mid-write, and nothing prevented `provider use` (a standalone command) from racing the account-switch cleanup path (which also touches this file) — e.g. an account switch could clear provider mode while a concurrent `provider use` was mid-write, and the loser's write would silently "win" the race, leaving the state inconsistent with what either command reported. Fix:
- **Atomic writes**: every write goes to a fresh temp file in the same directory (`tempfile.mkstemp`), then `os.replace()` (atomic rename) over the real path — an interrupted write can never leave a half-written `settings.json`.
- **One shared lock**: reuse the *same* lock `do_switch` already uses (`with_credential_lock`, `${RELAY_DIR}/credential.lock`) for every mutation of `settings.json`/`active_provider`/the snapshot file. Since account-switch cleanup runs from *inside* that lock already (`_do_switch_locked` executes as the guarded command), it calls the **non-lock-acquiring** inner implementation directly (`_settings_env_restore_locked`) rather than the public lock-acquiring wrapper (`_settings_env_restore`) — calling the wrapper from inside an already-held lock would deadlock (a second `flock()` on the same lockfile, from the same process tree, blocks forever waiting for a lock the outer call is still holding). This mirrors this codebase's existing `do_switch()` (public, acquires lock) / `_do_switch_locked()` (inner, assumes lock held) split.

## Commands

- `relay provider add <name> --base-url <url> --token <token> [--model <model>] [--discover-models]`
  Validates `<url>` looks like a URL, writes the JSON file (chmod 600), rejects if `<name>` collides with an existing account.
- `relay provider list`
  Lists configured providers (name, base_url, model if set), marks the active one (if any) with the same `✓`/highlight convention `relay list` uses for the active account.
- `relay provider remove <name>`
  Deletes the provider file. If it was active, also runs the `off` cleanup (see below) so settings.json doesn't keep a dangling override.
- `relay provider use <name>`
  1. Acquire the shared lock; read `~/.claude/settings.json` (create `{}` if absent), abort on malformed JSON.
  2. If `settings_env_snapshot.json` doesn't exist yet, write it now, capturing the current value/absence of all 4 managed keys (this is the *first* activation since the last full restore).
  3. Remove all 4 managed keys from `env` unconditionally, then add back exactly the keys this provider defines: `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, and (only if set) `ANTHROPIC_MODEL`, `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1"`. Everything else in `env` and the rest of the file is preserved untouched.
  4. Atomic write (temp file + rename), chmod 600 (the file now holds a secret token).
  5. Write `~/.claude-relay/active_provider` = `<name>`.
  6. Print confirmation, same tone as `do_switch`'s "✓ switched → name" message.
- `relay provider off`
  1. Acquire the shared lock; read `~/.claude/settings.json`.
  2. If a snapshot exists: restore each of the 4 managed keys to its snapshotted value, or remove it if the snapshot recorded it as absent; then delete the snapshot file. If no snapshot exists (defensive fallback — shouldn't normally happen), just remove the 4 managed keys.
  3. Atomic write.
  4. Delete `~/.claude-relay/active_provider`.
  5. Prints confirmation. Whatever subscription account is currently in Keychain silently resumes being "what's active" (it was never touched).
- **No `provider edit`/`update` command in v1.** Changing an existing provider's `base_url`/`token`/`model`/`discover_models` means `relay provider remove <name>` then `relay provider add <name> ...` again. Consistent with keeping v1 minimal; can be added later if re-adding proves annoying in practice.
- `relay run <name> [-- <claude args...>]`
  Dispatch on which store `<name>` is found in:
  - **account:** call the same switch path `relay <name>` uses, then `exec claude "$@"`.
  - **provider:** `exec claude --settings "$(provider_settings_json <name>)" "$@"` — no global file touched.
  - **neither:** error, same message style as today's `account_exists` failure.

**Mutual exclusion enforcement:**
- `_do_switch_locked` (existing account switch path, already running inside the shared lock) additionally calls `_settings_env_restore_locked` when a provider is active — restoring the pre-relay snapshot (or clearing the 4 keys as a defensive fallback) and removing `active_provider` — so a stale `ANTHROPIC_BASE_URL` can never silently keep routing a "switched back to subscription" session through the old proxy, and the restore can never race a concurrent `provider use`/`off` since they all serialize through the same lock.
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
- User already had `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_MODEL` set in `settings.json` before ever running `relay provider use` → snapshotted on first activation, restored verbatim (value or absence) on the eventual full exit from provider mode.
- Switching directly from provider A (with `model`/`discover_models` set) to provider B (with neither) → B ends up with exactly its own 2 keys; A's `ANTHROPIC_MODEL`/`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` do not leak forward.
- A crash/interrupt mid-write to `settings.json` → atomic rename means the file is either the old complete content or the new complete content, never a partial write.
- Concurrent `relay provider use` in one terminal and `relay <account>` in another → serialized by the shared lock; whichever wins the race, the loser's view is consistent with what actually landed (no silent overwrite of a "successful" command's effect by a stale write).

## Testing plan

1. `relay provider add mylitellm --base-url http://localhost:4000 --token sk-test` → `relay provider list` shows it, unmarked as active.
2. `relay provider use mylitellm` → `~/.claude/settings.json`'s `env` has the 3-4 expected keys; `relay status` shows the `⚡ litellm:` banner; unrelated pre-existing keys in settings.json (seed the file with e.g. `{"env":{"FOO":"bar"},"model":"opus"}` first) survive untouched.
3. `relay <some-account>` → provider keys are gone from settings.json's `env`, `active_provider` file gone, account table/current highlight correct.
4. `relay provider off` while a provider is active → keys removed, subscription resumes (no Keychain write needed — verify Keychain content unchanged before/after).
5. `relay provider add samename` where `samename` is an existing account name → rejected. Same test reversed (`relay add` colliding with existing provider name).
6. `relay run mylitellm -- -p "say hi"` with the fake-proxy harness from Verification, with a *different* provider simultaneously `relay provider use`'d globally → confirm the `run` session hits the fake proxy tied to `mylitellm`'s config, not whatever's globally active.
7. `relay run <account-name>` → confirms it behaves identically to `relay <account-name>` followed by `claude`.
8. Seed `settings.json` with `{"env":{"ANTHROPIC_BASE_URL":"https://my-own-gateway","ANTHROPIC_AUTH_TOKEN":"my-own-key"}}` *before* ever running `relay provider`. `relay provider use mylitellm` → those values snapshotted. `relay provider off` → `env` back to exactly `{"ANTHROPIC_BASE_URL":"https://my-own-gateway","ANTHROPIC_AUTH_TOKEN":"my-own-key"}`.
9. `relay provider add withmodel --base-url http://localhost:4000 --token sk-a --model claude-opus-4-7 --discover-models`, `relay provider add plain --base-url http://localhost:5000 --token sk-b`. `relay provider use withmodel` then `relay provider use plain` → `env` has only `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` for `plain`; no leftover `ANTHROPIC_MODEL`/`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY`.
10. `relay provider use withmodel` → `off` → confirm `settings_env_snapshot.json` is deleted and the *original* pre-provider state (not `withmodel`'s) is what's restored.

## Docs

- `CLAUDE.md` architecture section: add `~/.claude-relay/providers/` and `~/.claude-relay/active_provider` alongside the existing `credentials/`/`order` state-file notes, and a one-line mention that provider mode writes to `~/.claude/settings.json`'s `env` block rather than the credential store.
- `README.md`: new subsection under existing account docs covering `relay provider add/list/use/off/remove` and `relay run`, with the LiteLLM `config.yaml` minimal example from this doc.

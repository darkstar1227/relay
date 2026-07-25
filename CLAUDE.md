# relay

Multi-account switcher for Claude Code.

## Package

npm: `@dst-justin/relay` (scoped, public)  
GitHub: `darkstar1227/relay`

## Architecture

Everything lives in one bash script, `relay` (~1800 lines, macOS bash 3.2 compatible). Key pieces:
- Command dispatch is a single `case` at the bottom of the file (search `cmd_<name>` for each subcommand's implementation).
- The autoswitch daemon is Python, embedded as a heredoc inside `relay` (`_extract_daemon()`) and written out to `~/.claude-relay/autoswitch-daemon.py` at install time. It's managed via a macOS launchd plist or Linux systemd user service — there is no separate daemon source file in this repo.
- Credentials: macOS uses Keychain (service `Claude Code-credentials`); Linux uses `~/.claude/.credentials.json`. Relay's own per-account store lives at `~/.claude-relay/credentials/<name>.json`.
- Account display/switch order is persisted in `~/.claude-relay/order` (one name per line, add-order) — this is the single source of truth for ordering; every listing/index/autoswitch-default path reads it instead of sorting filenames. Self-healing: stale entries are dropped and untracked credential files are appended automatically. Use `relay reorder` to change it.
- LiteLLM provider mode: `~/.claude-relay/providers/<name>.json` (chmod 600, same convention as account credentials) stores `base_url`/`auth_token`/`model`/`discover_models` for each configured LiteLLM proxy. `relay provider use <name>` merges the corresponding `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_MODEL`/`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` keys into `${CLAUDE_DIR}/settings.json`'s `env` block (never the credential store) and records the active one in `~/.claude-relay/active_provider`; `relay provider off` reverses it. Mutually exclusive with subscription-account mode — switching one always clears the other's active marker. `relay run <name>` bypasses both global mechanisms for a single launch: for an account it's switch-then-exec; for a provider it uses `claude --settings '<inline JSON>'`, which is immune to concurrent global-state changes.
- Gotcha: on macOS, `relay` deliberately prefers `/usr/bin/python3` over a Homebrew python3 — the system Python uses the correct TLS cert store, Homebrew's often doesn't (see comment at `relay:19-25`).

Known issues and in-flight design context: see `TODOS.md` and `docs/plans/*.md`.

## Version

Single source of truth: `package.json` → `"version"`

The `relay` script reads version from `package.json` at runtime — no hardcoded version anywhere else.

**Before every npm publish**, bump `package.json` version:
- patch (bug fix): `npm version patch`
- minor (new feature): `npm version minor`
- major (breaking): `npm version major`

These commands update `package.json` AND create a git tag automatically.

## Publish checklist

```bash
npm version patch        # or minor/major
git push && git push --tags
npm publish --access public
```

**Every version bump must also:**
1. Add an entry to the `## Changelog` section in `README.md` — format:
   ```
   ### vX.Y.Z — YYYY-MM-DD
   - what changed (one bullet per meaningful change)
   ```
2. Create a GitHub release for the tag with the same release notes:
   ```bash
   gh release create vX.Y.Z --title "vX.Y.Z" --notes "$(cat <<'EOF'
   - what changed
   EOF
   )"
   ```

## Files

- `relay` — main bash script (macOS/Linux)
- `relay.js` — npm entry point, routes to relay or relay.ps1
- `relay.ps1` — PowerShell version (Windows)
- `relay.cmd` — Windows cmd shim

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec

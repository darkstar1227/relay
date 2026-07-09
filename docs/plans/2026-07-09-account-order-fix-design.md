# Account order fix — design

## Problem

Two independent bugs, both surfaced by the same user report (screenshots showing account order mismatches):

1. **Display order is alphabetical, not add-order.** `relay list` / `!relay <N>` / the autoswitch defaults all derive account order via `sorted()` (Python) or `sort` (bash) over credential filenames, in four separate places:
   - `list_account_names()` (relay:73-78)
   - `render_table`'s embedded Python (relay:168)
   - `autoswitch-daemon.py`'s `load_config()` auto-default (relay:1036)
   - `cmd_lock`'s auto-default config generator (relay:1496)

   Real accounts added `personal → work → allen-work` display as `allen-work, personal, work` (alphabetical). There is no persisted "add order" anywhere, and credential files are fully overwritten on `relay refresh`/re-login, so file birth-time can't be used to reconstruct history either (verified: `stat -f %B` order didn't match the user's stated real add order).

2. **Autoswitch reorder input is silently discarded.** `cmd_autoswitch_config` Step 1 (relay:1150) does:
   ```bash
   order_str=$(echo "${order_input}" | "${PY}" - "${accounts[@]}" <<'PYEOF'
   ...
   PYEOF
   )
   ```
   Piping stdin *and* using a heredoc on the same command is a conflict — the heredoc redirection wins, so `sys.stdin.read()` inside the script always sees an empty string. Whatever the user typed is discarded, and the code falls back to the default (untouched) order. Reproduced exactly: typing `312` (no separators) resulted in the config being saved with the original, unreordered list.

## Fix 1 — Canonical order file

New file `${RELAY_DIR}/order` (`~/.claude-relay/order`) — plain text, one account name per line. Single source of truth for ordering, replacing every ad-hoc sort.

**`list_account_names()`** (relay:73) rewritten to:
1. Read `${RELAY_DIR}/order`.
2. Drop names whose credential file no longer exists.
3. Append any credential file not yet listed, alphabetically, to the end (self-healing).
4. Rewrite the order file if anything changed in steps 2-3.
5. Print resulting names, one per line — same output contract as today.

**Write-side hooks:**
- `cmd_add` (relay:573) — append new name to `order` after writing credentials (idempotent).
- `cmd_save` (relay:621) — same idempotent append.
- `cmd_remove` (relay:729) — delete the name's line from `order`.
- `cmd_refresh` / re-login — no change (order untouched; only credentials for an existing name change).

**Python call sites** (`render_table`, `autoswitch-daemon.py`'s `load_config()`, `cmd_lock`'s auto-default generator) read `${RELAY_DIR}/order` directly instead of `sorted(glob(...))`, with the same self-heal filter duplicated inline — consistent with this codebase's existing pattern of duplicating small logic across embedded heredocs rather than sharing a module (see the `try_refresh`/`_try_refresh` "ponytail" comment at relay:464).

**Bootstrap for existing installs:** if `order` doesn't exist but credential files do, it's created via the self-heal path in alphabetical order (safe, deterministic, no worse than today's behavior). This repo's own local install (`~/.claude-relay/order`) will be seeded directly with the user-confirmed real order: `personal, work, allen-work`.

## Fix 2 — Autoswitch order-input parsing

Stop piping `order_input` through stdin; pass it via argv instead, eliminating the pipe/heredoc conflict entirely:

```bash
order_str=$("${PY}" - "${order_input}" "${accounts[@]}" <<'PYEOF'
import sys, re
raw = sys.argv[1].strip()
accts = sys.argv[2:]
...
PYEOF
)
```

**Concatenated-digit shorthand:** when the raw input has no whitespace/comma separators, is all digits, and `len(accts) <= 9`, split it into individual single-digit picks (`"312"` → `[3, 1, 2]`). Only enabled in the ambiguity-free case; anything else still requires separators. Prompt text updated to mention both forms (e.g. `2 1` or `21` for ≤9 accounts).

**Shared `prompt_reorder(accounts...)` function:** extracts the "show numbered list → read input → resolve to order_str → show chain" logic (relay:1140-1173) into one bash function, used by both `cmd_autoswitch_config` Step 1 and the new `cmd_reorder` (Fix 3). One implementation, fixed once.

## Fix 3 — New `relay reorder` command

Today the only way to influence order is buried inside the 3-step `relay autoswitch config` wizard, which also asks about thresholds and polling — a bad fit for someone who just wants to fix display order without using autoswitch.

`relay reorder`:
1. Loads current order via `list_account_names`.
2. Calls the shared `prompt_reorder()` picker.
3. Writes resolved order to `${RELAY_DIR}/order`.
4. If `${RELAY_DIR}/autoswitch.json` exists, also updates its `"order"` field to match, so the two never drift apart (the second symptom in the original report — display order and autoswitch order disagreeing). If no autoswitch config exists, only `order` is touched.
5. Prints the resolved chain (`personal → work → allen-work → (cycle)`) for confirmation.

Dispatch added to the case statement near relay:1795-1797, alongside `list`/`remove`; one-line help text entry added.

## Edge cases

- Credential file added outside normal flow (manual `cp`) → appended alphabetically at end on next read, `order` updated.
- Credential file removed via `rm` (not `relay remove`) → dropped from `order` on next read.
- `order` file missing/corrupted → full self-heal rebuild from credential files, never crashes.
- Autoswitch config referencing a name no longer present → existing tolerant behavior unchanged.

## Testing plan

1. Fresh install: `relay add a`, `relay add b`, `relay add c` in that order → `relay list` shows `a, b, c` even when alphabetically out of order (e.g. add `z` before `a`, confirm `z` stays first).
2. Overwrite a credential file's content (simulating `relay refresh`) → confirm order unaffected.
3. `relay remove b` → confirm `b` gone from both `order` and `relay list`.
4. `relay reorder` with `3 1 2` and shorthand `312` (≤9 accounts) → confirm identical results, persisted to `order` (and `autoswitch.json` if present).
5. `relay autoswitch config` Step 1 with shorthand input → confirm saved `order` in `autoswitch.json` reflects what was actually typed (direct regression test for the reported bug).
6. Manually seed this repo's `~/.claude-relay/order` with `personal, work, allen-work` → confirm `relay list` and `!relay 1/2/3` match.

## Docs

Update `CLAUDE.md`'s architecture notes to mention `~/.claude-relay/order` as a load-bearing state file alongside `credentials/` and `meta/`.

# Development and release assembly

Relay is developed as grouped Bash templates and Python sources. The root
`relay` executable is a **generated, checked-in release artifact**. It remains
self-contained: manual installs and the existing direct updater still copy or
download one file. Runtime requirements remain unchanged; subsequent acceptance
also corrected updater failures and Windows PowerShell 5.1 compatibility issues.

## Editing and building

Use Node 22+ for development tests (CI uses Node 24), Bash and Python 3. The
published Node launcher continues to support Node 16+. No npm dependencies are
needed to build or run the test suite.

```sh
npm run build
npm run build:check
npm test
npm run test:package
```

- `src/manifest.json` is the explicit concatenation order. Never infer ordering
  from filenames or directory enumeration. `blankLineAfter` controls blank lines
  between modules; the builder normalizes leading/trailing empty lines at module
  boundaries so an editor's EOF policy does not change the release artifact.
- `src/shell/` groups bootstrap, account storage and switching, usage display,
  providers, proxy supervision, run, account management, autoswitch, account
  policy, warmup, maintenance, help and dispatch. These are **templates**, not
  independently executable shell libraries. Dispatch is last; preserving the
  original ordering also preserves initialization side effects.
- `src/python/` holds the embedded programs. A `{{python:name.py}}` marker is
  expanded in place, removing only the Python file's final LF. The template
  owns the surrounding quotes and newlines. Several callers may share one
  identical source, such as access-token extraction.
- `scripts/build.cjs` rejects missing sources, duplicate shell modules,
  unreferenced sources, malformed markers and invalid line endings. It emits
  no timestamps or machine paths. `--check` assembles in a temporary directory
  and fails on drift without repairing the checked-in artifact.

Edit the sources, run the build and commit the sources **and** `relay` together.
Do not edit the generated executable. Builds preserve its executable mode.

Python insertion is textual, not shell escaping. Preserve the enclosing
single/double-quote contract when editing an inline `-c` program. File paths such
as the package path in `read_version.py` are passed as argv, not interpolated into
Python source. Heredoc programs keep their original terminators.
Always run the syntax and behavioral tests after editing these sources.

## Tests and isolation

The tests use temporary homes (including spaces in paths), fake account data,
intercepted platform/credential/service commands and an in-memory HTTP boundary.
Python sockets are disabled by test-only `sitecustomize.py`; unknown HTTP
requests fail. Tests do not log in, contact Anthropic, schedule real services or
invoke real Claude/Codex. The macOS test runner deliberately uses the Linux
file-credential adapter, so passing tests are not proof of real Keychain access.

Coverage includes build failure modes, CLI aliases, account order healing,
numeric switching and outgoing credential backup, reorder/rename/remove,
provider argument and token handling, cache/refresh/HTTP failures, warmup and
locks, session listing, daemon extraction and scheduling policy, single-instance
checks, and direct single-file installation. Existing behaviors are preserved,
including documented limitations in `TODOS.md`.

To apply the behavior suite to a different **trusted** revision, materialize its
`relay` and matching `package.json` in a disposable directory and run:

```sh
RELAY_TEST_SCRIPT=/absolute/path/to/baseline/relay node --test tests/cli.test.cjs tests/daemon.test.cjs
```

The current version assertions require a matching package version. For future
cross-version comparisons, normalize only declared version differences. Never
run unknown/untrusted scripts through this harness: it is test isolation, not
an operating-system security sandbox.

For this stage-one migration, `node scripts/compare-baseline.cjs` materializes the
fixed `v2.9.0` commit in a temporary directory, checks assembly synchronization and runs
the same CLI/daemon suite against both versions. It needs the baseline Git object
locally and is an acceptance tool, not a permanent restriction on future features.

Update acceptance subsequently found and fixed existing updater defects. The
comparison now checks assembly synchronization and the unchanged account/daemon
behavior, rather than requiring byte identity with the unpatched baseline.
`tests/update.test.cjs` separately covers old-to-new single-file installation,
download rejection, npm/Git failures, symlinks, a real isolated npm upgrade, a
local Git worktree fast-forward and daemon deployment/restart failure handling.

The generated executable embeds the version from `package.json`, so a standalone
copy reports its version without adjacent package metadata. npm updates install
the exact discovered version and verify the resulting package; Git updates use
fast-forward-only pull. Direct downloads validate the Bash header, syntax and any
embedded version before atomic replacement. Daemon redeploy failures restore the
previous file and version marker; a successful service command alone is not a
production health probe.

## Packaging and CI

`npm run test:package` packs the current generated artifact, installs the exact
tarball offline into a disposable prefix, executes its real postinstall in that
prefix and checks the installed launcher. It does not require source files in
the installed package. Use `-- --pack-dir dist` to retain the verified tarball;
use `-- --tarball /path/to/file.tgz` to test an existing artifact without repacking.

On Windows, the verifier first proves PowerShell home-directory isolation, then
tests the installed script with three mocked refresh responses (missing, zero,
and positive expiry). Keep `relay.ps1` UTF-8 **with BOM** for Windows PowerShell
5.1 and avoid PowerShell 7-only syntax such as `??`: the launcher uses
`powershell.exe`. These tests do not contact the real OAuth service.

The validation workflow runs on PRs and pushes to main and is reusable by the
tag-publish workflow. It checks source/assembly synchronization and behavior on
Linux and macOS (using `/bin/bash`, including the macOS Bash 3.2 contract), packs
once, then checks that same tarball on Linux, macOS and Windows with Node 16/24.
The Windows job exercises the existing PowerShell launcher, not POSIX feature
parity. No validation job has npm publishing credentials.

The publish workflow waits for all validation, requires `v<package.json version>`
to match the pushed tag, and publishes the already-validated tarball. It does
not rebuild after testing. Updating source files does not itself create a tag,
bump a version, create a GitHub release or publish to npm.

## Migration stages

Stage one only introduces source grouping, assembly and validation. The Rust
core work starts after this stage is accepted. See the migration and SRE
comparison plan in `docs/plans/2026-09-06-modular-rust-migration.md`.

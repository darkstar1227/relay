# relay

Multi-account switcher for Claude Code.

## Package

npm: `@dst-justin/relay` (scoped, public)  
GitHub: `darkstar1227/relay`

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

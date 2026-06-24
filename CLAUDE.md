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

## Files

- `relay` — main bash script (macOS/Linux)
- `relay.js` — npm entry point, routes to relay or relay.ps1
- `relay.ps1` — PowerShell version (Windows)
- `relay.cmd` — Windows cmd shim

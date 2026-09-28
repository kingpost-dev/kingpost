# Kingpost plugins

Two harness-specific plugins, both wrapping the global `kingpost` CLI (`npm i -g kingpost`). If `kingpost` isn't on PATH, hook invocations and the MCP server registration fail silently/non-fatally from the harness's point of view — run `kingpost doctor` (once it exists) to check.

## Manifest format asymmetries (schema-driven, not drift)

- **`owner` field**: `.claude-plugin/marketplace.json` has an `owner: {name: "Kingpost"}` object because Claude Code's marketplace schema requires it; `.agents/plugins/marketplace.json` (Codex) doesn't, because Codex's schema doesn't have an equivalent field. Don't "fix" this by mirroring one into the other.
- **`additionalContextLimit: 5000`**: present on all 4 Codex hook entries, absent from Claude Code's. This is a Codex-specific hook option; Claude Code's hook format has no equivalent field.
- **Codex's `plugin.json` has `"extensions": {"com.openai": {}}`**; Claude's has `"author": {"name": "Kingpost"}`. Both are schema-required fields for their respective harness, serving different purposes — not meant to mirror each other.

## Version sync

`packages/cli/package.json`, `plugins/claude-code/.claude-plugin/plugin.json`, and `plugins/codex/.codex-plugin/plugin.json` each independently declare `"version"`. There's no automated sync — when bumping the CLI version, bump both plugin manifests too.

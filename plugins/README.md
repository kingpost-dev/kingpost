# Kingpost plugins

Two harness-specific plugins, both wrapping the global `kingpost` CLI (`npm i -g kingpost`). If `kingpost` isn't on PATH, hook invocations and the MCP server registration fail silently/non-fatally from the harness's point of view — run `kingpost doctor` (once it exists) to check.

## Manifest format asymmetries (schema-driven, not drift)

- **`owner` field**: `.claude-plugin/marketplace.json` has an `owner: {name: "Kingpost"}` object because Claude Code's marketplace schema requires it; `.agents/plugins/marketplace.json` (Codex) doesn't, because Codex's schema doesn't have an equivalent field. Don't "fix" this by mirroring one into the other.
- **`additionalContextLimit: 5000`**: present on all 4 Codex hook entries, absent from Claude Code's. This is a Codex-specific hook option; Claude Code's hook format has no equivalent field.
- **Codex's `plugin.json` has `"extensions": {"com.openai": {}}`**; Claude's has `"author": {"name": "Kingpost"}`. Both are schema-required fields for their respective harness, serving different purposes — not meant to mirror each other.

## Version sync

`packages/cli/package.json`, `plugins/claude-code/.claude-plugin/plugin.json`, and `plugins/codex/.codex-plugin/plugin.json` each independently declare `"version"`. There's no automated sync — when bumping the CLI version, bump both plugin manifests too.

## Codex hook matcher: `apply_patch|Edit|Write|Bash`

This went through two wrong guesses before landing here — don't simplify it without re-verifying against a real captured hook payload:
- `apply_patch|Edit|Write` (original): missed Codex's `unified_exec`-wrapped Bash calls entirely.
- `apply_patch|Edit|Write|exec` (first fix attempt): `exec` was a wrong guess at the tool name — Codex's actual `PreToolUse` payload uses `tool_name: "Bash"`, not `"exec"`. This guess silently never matched anything.
- `apply_patch|Edit|Write|Bash` (current, verified): confirmed against a real captured Codex 0.158.0 `PreToolUse` payload.

Also note: neither `Bash` nor `apply_patch` tool calls carry a structured `file_path` field the way Claude's `Write`/`Edit` do. `apply_patch`'s path is extracted by regex from its patch text (`packages/cli/src/hooks/parse.ts`, `extractApplyPatchFilePath` — only the first file in a multi-file patch, see the code comment there); a generic `Bash` command has no reliable single-file signal at all and is left as `filePath: undefined` by design.

## Codex plugin install is two separate steps

`codex plugin add kingpost@kingpost` installs the plugin's files but does NOT auto-register its declared `mcp.json` with Codex's runtime — `codex mcp list` stays empty until you separately run `codex mcp add kingpost -- kingpost mcp` (writes `[mcp_servers.kingpost]` to `~/.codex/config.toml`). `kingpost join`'s printed instructions and `kingpost doctor`'s checks both account for this as two steps; don't assume `plugin add` alone is sufficient for Codex.

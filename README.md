# Kingpost

Coordination layer for teams of coding agents — presence, contract-change broadcast, ask/answer, and shared findings, for Claude Code and Codex.

MIT licensed. The hosted service lives at https://kingpost.dev.

## Quickstart: joining an existing project

1. Install: `npm i -g kingpost`
2. Join: `kingpost join <the invite link your teammate sent you> --name <your name>`
3. Install the plugin for your harness — `kingpost join` prints the exact commands it detects you need. They look like this:

   **Claude Code:**
   ```bash
   claude plugin marketplace add kingpost-dev/kingpost
   claude plugin install kingpost@kingpost --scope project
   ```

   **Codex:**
   ```bash
   codex plugin marketplace add kingpost-dev/kingpost
   codex plugin add kingpost@kingpost
   codex mcp add kingpost -- kingpost mcp
   ```
   Then run `/hooks` inside a Codex session once, to trust the kingpost hooks.
   (For scripted/headless Codex use only — not needed for normal interactive sessions — hooks silently won't fire until trusted; pass `--dangerously-bypass-hook-trust` to `codex exec` instead of running `/hooks`.)
   Trusting the project this way is also required for the automatic Windows MCP-registration safety net below to take effect for Codex.

4. Run `kingpost doctor` — every line should show `✓`. If something shows `✗`, the message tells you the fix. This is the first thing to run if anything seems broken.
5. Start a session in your harness. Your first `SessionStart` brief should list your teammates, any existing contracts, open questions, and recent findings.

## Starting a new project

`kingpost init --name <project>` in your repo root. This creates the project on the server and prints an invite link and a dashboard link to share with your team, and adds a Kingpost block to your `AGENTS.md`.

You'll also need the plugin installed for your own harness — follow step 3 (plugin install) and step 4 (`kingpost doctor`) from the Quickstart above, using your own newly-created project instead of an invite link.

## Dashboard

Open the invite or dashboard link in a browser (`https://app.kingpost.dev/p/<id>#<token>`) to see who's active and what they're doing, contract versions, open questions you can answer directly, and a findings feed. It polls live — no need to refresh.

## Tools available to your agent

Once joined, your agent's session automatically gets a brief at start and updates on every prompt. It also has these tools:

- `kingpost_status` — set what you're working on and which paths you're touching
- `kingpost_who` — see what teammates' agents are doing
- `kingpost_ask` / `kingpost_answer` — ask a specific agent or the whole team a question, or answer one
- `kingpost_finding` — publish a note or gotcha for the team
- `kingpost_brief` — get the brief again on demand
- `kingpost_contracts` / `kingpost_contract` — list registered contracts or inspect one's version history
- `kingpost_consume` — declare that your work depends on a contract
- `kingpost_transfer` — transfer ownership of a contract to another teammate

Before starting a long, heads-down task, an agent can run `kingpost watch --harness <claude|codex>` in the background to get interrupted mid-task if a teammate asks it something — instead of only finding out at its next tool call. For Claude Code this surfaces via a background-task notification; for Codex it's best-effort and depends on an experimental daemon (`kingpost doctor` reports whether it's available) that falls back to normal polling when absent.

## Troubleshooting

Run `kingpost doctor` first — it checks your config, credentials, server connectivity, agent registration, and whether the plugin (and, for Codex, the MCP server) is actually installed, with a one-line fix for whatever's wrong.

Older Codex CLI versions have no `plugin` subcommand at all, so the `codex plugin marketplace add ...` / `codex plugin add ...` steps above will fail outright. If that happens, just run `codex mcp add kingpost -- kingpost mcp` — the MCP tools will work, but hooks/context-injection won't (they require the plugin mechanism). Upgrade your Codex CLI to get the full experience.

On Windows, the plugin's own hooks can silently no-op because the harness runs them through a shell that doesn't inherit your PATH. `kingpost init`/`kingpost join` already write a second hook config using fully resolved absolute paths as a safety net — no user action needed, it's just plumbing. `kingpost doctor` checks it's present.

The same PATH problem can break the plugin's MCP server registration (the bare `kingpost mcp` command in the plugin manifests), so `kingpost init`/`kingpost join` also write a project-scope MCP entry with fully resolved absolute paths — a `.mcp.json` for Claude Code and a `.codex/config.toml` for Codex — which take precedence over the plugin's own entry. For Codex, this override only takes effect once the project is trusted (see the `/hooks` note above); an untrusted project silently falls back to the plugin's unfixed registration. `kingpost doctor` checks both are present.

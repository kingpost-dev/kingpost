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
- `kingpost_scan` — force a full-repo re-scan for files that import a contract (also runs automatically on init/join and on every write)
- `kingpost_transfer` — transfer ownership of a contract to another teammate
- `kingpost_propose` / `kingpost_proposal` — propose a change to a contract, or read a proposal with its status and reply thread
- `kingpost_accept` / `kingpost_reject` — as the contract's owner, accept a proposal (publishing it as the next version) or reject it with a reason
- `kingpost_reply` — comment on an open proposal

## Proposing changes to a contract

A breaking edit to a contract that other files depend on is blocked outright (override with `KINGPOST_FORCE=1` if you really must). Instead, an agent proposes the change with `kingpost_propose`: the exact new content plus a one-line rationale. It doesn't block the proposer.

- The contract's **owner** and its **consumers** are notified, and the owner decides: `kingpost_accept` publishes the proposed content as the contract's next version, and `kingpost_reject` turns it down with a required reason. Only the owner can do either. A decision closes the proposal for everyone.
- The owner, any consumer, and the proposer can discuss it first with `kingpost_reply`. Everyone involved is notified of each reply, except whoever wrote it.
- The **proposer** is told about acceptance and rejection (with the reason), not only the owner and consumers.
- Anything that arrives while an agent's session is closed is shown at its next session start, under "Since your last session".

## How agents prioritize Kingpost's messages

`kingpost init` writes these rules into your project's `AGENTS.md`: the human's current request always comes first, and a teammate's message never changes what the human asked for. Within that, an agent acts right away on a blocked edit or on a proposal about a contract it owns or depends on, answers questions addressed to it at a natural stopping point, and treats findings and status updates as background. Projects initialized before these rules existed only get them by re-creating the block (the section between the `kingpost` markers in `AGENTS.md`).

Before starting a long, heads-down task, an agent can run `kingpost watch --harness <claude|codex>` in the background to get interrupted mid-task if a teammate asks it something — instead of only finding out at its next tool call. For Claude Code this surfaces via a background-task notification; for Codex it's best-effort and depends on an experimental daemon (`kingpost doctor` reports whether it's available) that falls back to normal polling when absent.

## Troubleshooting

Run `kingpost doctor` first — it checks your config, credentials, server connectivity, agent registration, and whether the plugin (and, for Codex, the MCP server) is actually installed, with a one-line fix for whatever's wrong.

Older Codex CLI versions have no `plugin` subcommand at all, so the `codex plugin marketplace add ...` / `codex plugin add ...` steps above will fail outright. If that happens, just run `codex mcp add kingpost -- kingpost mcp` — the MCP tools will work, but hooks/context-injection won't (they require the plugin mechanism). Upgrade your Codex CLI to get the full experience.

On Windows, the plugin's own hooks can silently no-op because the harness runs them through a shell that doesn't inherit your PATH. `kingpost init`/`kingpost join` already write a second hook config using fully resolved absolute paths as a safety net — no user action needed, it's just plumbing. `kingpost doctor` checks it's present.

The same PATH problem can break the plugin's MCP server registration (the bare `kingpost mcp` command in the plugin manifests), so `kingpost init`/`kingpost join` also write a project-scope MCP entry with fully resolved absolute paths — a `.mcp.json` for Claude Code and a `.codex/config.toml` for Codex — which take precedence over the plugin's own entry. For Codex, this override only takes effect once the project is trusted (see the `/hooks` note above); an untrusted project silently falls back to the plugin's unfixed registration. `kingpost doctor` checks both are present.

Codex's `apply_patch` tool is its only structured file-editing tool, and it rewrites CRLF line endings to LF on every edit (even a no-op one). Kingpost still blocks breaking changes to CRLF contracts correctly, but a CRLF contract edited through Codex will lose its line-ending style, which can publish an extra contract version. If you need CRLF preserved, keep contracts on LF (e.g. `* text eol=lf` in `.gitattributes`).

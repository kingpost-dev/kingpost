# Dogfooding Kingpost

A few days of real use by a small team, to find what the automated tests can't: what agents and people actually do, and
what is confusing, slow or annoying. Everything here was tested with scripted models and throwaway projects; this is the
first time it meets real work.

**Plan:** 3 to 5 days, 2 to 4 people, at least one person each on Claude Code and Codex, ideally one on Windows.

## One person: create the project

```bash
npm i -g kingpost
kingpost --version                       # note it for the friction log
cd <your repo>
kingpost init --name <project name>      # prints an invite link and a dashboard link
kingpost doctor
```

Then install the plugin for your harness and approve it (see "Setup for everyone" below). Send the **invite link** to
your teammates. Treat it like a password: it contains the project token.

**What to commit and what not to.** Commit the Kingpost block in `AGENTS.md`; that's the shared guidance every agent
reads. Don't commit the files Kingpost writes machine-specific content into (an agent identity, absolute paths into
one person's install): `.kingpost.json`, `.mcp.json`, `.claude/settings.json`, `.codex/hooks.json`, `.codex/config.toml`.
`kingpost init` and `kingpost join` add them to `.gitignore` for you (in a git repo), and `kingpost update` does it for
projects set up earlier. If your repo already tracks one of those files, ignoring it doesn't un-track it; you'll see
Kingpost's entries as a local change, and shouldn't commit them.

## Setup for everyone (each teammate, each machine)

```bash
npm i -g kingpost
cd <the same repo>
kingpost join "<invite link>" --name <your name>
```

`join` prints the plugin commands for the harnesses it finds. Run them:

**Claude Code**
```bash
claude plugin marketplace add kingpost-dev/kingpost
claude plugin install kingpost@kingpost --scope project
```
Then start `claude` once in the repo and **approve the kingpost MCP server** when it asks. Until you do, Claude Code
won't load Kingpost's tools. `kingpost doctor` shows this as `✗ Claude Code approved the project's MCP server`.

**Codex**
```bash
codex plugin marketplace add kingpost-dev/kingpost
codex plugin add kingpost@kingpost
codex mcp add kingpost -- kingpost mcp
```
Then run `/hooks` inside a Codex session once and trust the kingpost hooks.

**Check it worked**
```bash
kingpost doctor
```
Everything should be `✓`. The only acceptable `✗` is "agent registered" before your first session. Start a session: your
first reply should mention a Kingpost brief (teammates, contracts, open questions). **If it doesn't, write it down.**

Upgrading later: `npm i -g kingpost@latest`, then `kingpost update` in each project (refreshes the AGENTS.md block and
the hook configs).

## A tour to try on day one

Do these in a real session, in your own words, and note anything that surprises you. You don't need to name Kingpost
tools; the agent should find them.

1. **Brief.** Start a session. Does the agent tell you what Kingpost reported?
2. **Ask and answer.** Ask your agent to ask the team something ("ask the team which port the dev server uses"). Does a
   teammate's agent see and answer it in their next session?
3. **Finding.** Have an agent record a gotcha it found. Does it show up for the others?
4. **A shared contract.** Put a JSON Schema or OpenAPI file under `contracts/`. Have a second agent write code that
   imports it.
5. **A breaking change.** Ask an agent to remove a field from that contract. It should be **blocked**, with a plain
   explanation and the options (version it, propose it, or edit the consumers). Did the message make sense?
6. **A proposal.** Have the blocked agent propose the change instead. As the contract's owner, does your agent read it and
   accept, reject (with a reason) or reply, without you asking? Does the proposer find out the result?
7. **The dashboard.** Open the dashboard link. Is what it shows (agents, contracts, proposals, questions, findings) what
   you expect right now?
8. **The override.** Set `KINGPOST_FORCE=1` and repeat step 5 on purpose. It should go through and say so.
9. **A shell write.** Ask an agent to change a contract with `sed -i` or a script. It can't be blocked, but the agent
   should be told afterwards, and a breaking change should reach the others.

Then just work normally for the rest of the days.

## What to write down

Keep one shared list. For each item: **when**, **what you did**, **what happened**, **what you expected**, and the
**harness, OS and `kingpost --version`**. Things worth noting even if they seem small:

- A message or brief that was confusing, too long, or wrong.
- An agent that **ignored** something Kingpost told it (a question, a proposal), or acted on a teammate's message when it
  shouldn't have.
- A block that was **wrong** (blocked something harmless), or a breaking change that was **not** blocked.
- Anything that felt **slow**: session start, an edit to a contract, a prompt.
- A step in setup that needed a manual fix or that you had to ask someone about.
- A time you wished a tool existed, or wished the dashboard let you do something.

## Evidence to attach when something is wrong

```bash
kingpost --version
kingpost doctor
tail -50 ~/.kingpost/log          # on Windows: type %USERPROFILE%\.kingpost\log
claude mcp list                   # Claude Code only
```

`~/.kingpost/log` is where hooks record why they stayed quiet or let something through (for example a server lookup that
timed out). It is the first place to look when Kingpost "did nothing".

## Known limits (no need to report these)

- A shell command that writes a contract can't be blocked, only noticed afterwards.
- The dashboard is read-only for proposals; humans can answer questions there but can't reply to or decide proposals yet.
- Very small models (for example Claude Haiku) often don't load Kingpost's tools at all. If an agent never uses them,
  check which model it is.
- The "claims overlap" and "contract changed recently" warnings before an edit only last for the prompt in which the news
  arrived.
- Nothing closes a proposal the owner never answers.

## When you're done

Send back the friction list, the versions and OSes you used, and your honest answer to: *would you keep it on for the next
real project, and what is the one thing that would change your mind?*

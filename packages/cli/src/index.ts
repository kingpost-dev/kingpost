#!/usr/bin/env node
import { Command } from "commander";
import { initCommand } from "./commands/init.js";
import { joinCommand } from "./commands/join.js";
import { hookCommand } from "./commands/hook.js";
import { mcpCommand } from "./commands/mcp.js";
import { doctorCommand } from "./commands/doctor.js";
import { inboxCommand } from "./commands/inbox.js";
import { HarnessSchema } from "@kingpost/protocol";

const program = new Command();
program.name("kingpost").version("0.1.0");

program
  .command("init")
  .requiredOption("--name <name>", "project name")
  .option("--server-url <url>", "override the kingpost server URL (self-host / testing)")
  .action(async (opts) => {
    await initCommand(opts.name, { serverUrl: opts.serverUrl });
  });

program
  .command("join <link>")
  .requiredOption("--name <name>", "your name")
  .action(async (link, opts) => {
    await joinCommand(link, { name: opts.name });
  });

program
  .command("hook <event>")
  .requiredOption("--harness <harness>", "claude or codex")
  .action(async (_event, opts) => {
    await hookCommand(HarnessSchema.parse(opts.harness));
  });

program.command("mcp").action(async () => {
  await mcpCommand();
});

program.command("doctor").action(async () => {
  await doctorCommand();
});

program
  .command("inbox")
  .option("--watch", "keep polling for new questions (currently always on — the flag is accepted for interface familiarity, there's no one-shot mode)")
  .requiredOption("--name <name>", "your name, used as the answer author")
  .action(async (opts) => {
    await inboxCommand({ userName: opts.name });
  });

program.parseAsync(process.argv);

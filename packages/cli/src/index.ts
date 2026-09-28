#!/usr/bin/env node
import { Command } from "commander";
import { initCommand } from "./commands/init.js";
import { joinCommand } from "./commands/join.js";

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

program.parseAsync(process.argv);

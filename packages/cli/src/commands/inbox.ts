import { createInterface } from "node:readline";
import { readProjectConfig, getToken } from "../config.js";
import { ApiClient } from "../api.js";
import type { Question } from "@kingpost/protocol";

const POLL_MS = 3000;

export async function inboxCommand(opts: { userName: string; cwd?: string }): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const config = readProjectConfig(cwd);
  if (!config) {
    console.error("No .kingpost.json found — run 'kingpost init' or 'kingpost join' first.");
    return;
  }
  const token = getToken(config.projectId);
  if (!token) {
    console.error("No credentials — run 'kingpost join <invite-link>'.");
    return;
  }
  const client = new ApiClient(config.serverUrl, config.projectId, token);

  const seen = new Set<string>();
  let open: Question[] = [];

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log(`Watching for open questions as ${opts.userName}. Type '<number> <answer>' to answer. Ctrl+C to quit.`);

  async function poll() {
    try {
      const { questions } = await client.listQuestions();
      open = questions.filter((q) => q.status === "open" && (q.toAgentId === null));
      for (const q of open) {
        if (seen.has(q.id)) continue;
        seen.add(q.id);
        const idx = open.indexOf(q);
        console.log(`\n[${idx}] ${q.text}`);
      }
    } catch (e) {
      console.error(`(inbox poll failed: ${e instanceof Error ? e.message : String(e)})`);
    }
  }

  await poll();
  const interval = setInterval(poll, POLL_MS);

  rl.on("line", async (line) => {
    const match = line.match(/^(\d+)\s+(.+)$/);
    if (!match) {
      console.log("Format: '<number> <answer text>'");
      return;
    }
    const [, idxStr, text] = match;
    const question = open[Number(idxStr)];
    if (!question) {
      console.log("No open question at that index.");
      return;
    }
    try {
      await client.answerQuestion(question.id, { text, byUserName: opts.userName });
      console.log(`Answered [${question.id}].`);
    } catch (e) {
      console.error(`Failed to answer: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  rl.on("close", () => {
    clearInterval(interval);
    process.exit(0);
  });
}

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
    process.exitCode = 1;
    return;
  }
  const token = getToken(config.projectId);
  if (!token) {
    console.error("No credentials — run 'kingpost join <invite-link>'.");
    process.exitCode = 1;
    return;
  }
  const client = new ApiClient(config.serverUrl, config.projectId, token);

  // Stable index -> question mapping. Indices are assigned once and never reused or
  // reassigned to a different question, so "<index> <answer>" always refers to the same
  // question it did when printed — even across poll cycles where other questions are
  // answered or added concurrently by other agents/humans.
  const byIndex = new Map<number, Question>();
  let nextIndex = 0;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log(`Watching for open questions as ${opts.userName}. Type '<number> <answer>' to answer. Ctrl+C to quit.`);

  async function poll() {
    try {
      const { questions } = await client.listQuestions();
      const openTeamWide = questions.filter((q) => q.status === "open" && q.toAgentId === null);
      const openIds = new Set(openTeamWide.map((q) => q.id));

      // Drop indices whose question is no longer open (answered elsewhere) — never reused.
      for (const [idx, q] of byIndex) {
        if (!openIds.has(q.id)) byIndex.delete(idx);
      }

      const alreadyTracked = new Set([...byIndex.values()].map((q) => q.id));
      for (const q of openTeamWide) {
        if (alreadyTracked.has(q.id)) continue;
        const idx = nextIndex++;
        byIndex.set(idx, q);
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
    const idx = Number(idxStr);
    const question = byIndex.get(idx);
    if (!question) {
      console.log(`No open question at [${idx}] (it may already have been answered by someone else, or that index was never assigned).`);
      return;
    }
    try {
      await client.answerQuestion(question.id, { text, byUserName: opts.userName });
      byIndex.delete(idx);
      console.log(`Answered [${idx}].`);
    } catch (e) {
      console.error(`Failed to answer: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  rl.on("close", () => {
    clearInterval(interval);
    process.exit(0);
  });
}

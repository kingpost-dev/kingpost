// End-to-end check against a REAL agent harness (Claude Code or Codex) and the real Kingpost server:
// a breaking edit to a consumed contract must be blocked, and the same request with KINGPOST_FORCE=1
// must go through. The second run is the control: it proves the model WOULD make the edit, so the
// first run staying unchanged is the hook's doing and not the model declining on its own.
//
//   node scripts/e2e-real-harness.mjs <claude|codex>
//
// Runs with a scripted model by default, or the real one with KINGPOST_E2E_MODEL=real (see e2e-lib.mjs).
// Needs the built CLI (npm run build) and the harness binary on PATH. Creates a throwaway project on the
// server (KINGPOST_E2E_SERVER, default https://app.kingpost.dev) and deletes it again when it finishes.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startFakeModel } from "./fake-model/server.mjs";
import {
  api, costSummary, deleteProject, fail, fakeMode, harnessCommand, loadProject, makeTempDir, prepareCodexHome,
  reportFailure, runAsync, runKingpost, server, toolsUsed,
} from "./e2e-lib.mjs";

const harness = process.argv[2];
if (harness !== "claude" && harness !== "codex") {
  console.error("usage: node scripts/e2e-real-harness.mjs <claude|codex>");
  process.exit(2);
}

const CONTRACT = "contracts/user.json";
const ORIGINAL =
  JSON.stringify({ type: "object", properties: { name: { type: "string" }, age: { type: "number" }, email: { type: "string" } }, required: ["name"] }, null, 2) + "\n";
const PROMPT =
  `First read ${CONTRACT}, then edit it to remove the age property from properties. Use your file-editing tool, not the shell. ` +
  `Make exactly that one change. Do not call any kingpost_* tools; they are not needed for this task. ` +
  `If the edit is refused, do not try another way around it; just say it was refused.`;

const dir = makeTempDir(`kp-e2e-${harness}-`);
console.log(`[${harness}] project dir: ${dir}`);
let fake;
let codexHome;
let project;
try {
  mkdirSync(join(dir, "contracts"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, CONTRACT), ORIGINAL);
  writeFileSync(join(dir, "src/uses-user.ts"), `import type { User } from "../contracts/user.json";\nexport const u: User | null = null;\n`);

  if (fakeMode) {
    const ageBlock = `    "age": {\n      "type": "number"\n    },\n`;
    fake = await startFakeModel({
      // Read the contract, then remove the age property: the same edit the real-model prompt asks for.
      claudeSteps: [
        { tool: "Read", input: { file_path: join(dir, CONTRACT) } },
        { tool: "Edit", input: { file_path: join(dir, CONTRACT), old_string: ageBlock, new_string: "" } },
        { text: "Done." },
      ],
      codexSteps: [
        { tool: "exec_command", input: { cmd: `cat ${CONTRACT}` } },
        {
          tool: "apply_patch",
          input: `*** Begin Patch\n*** Update File: ${CONTRACT}\n@@\n     "name": {\n       "type": "string"\n     },\n-    "age": {\n-      "type": "number"\n-    },\n     "email": {\n*** End Patch\n`,
        },
        { text: "Done." },
      ],
    });
  }
  if (harness === "codex") codexHome = prepareCodexHome([dir], fake?.url);

  const init = runKingpost(["init", "--name", `e2e-${harness}-${Date.now()}`, "--server-url", server], { cwd: dir });
  if (init.status !== 0) fail("kingpost init failed", init.stdout + init.stderr);
  project = loadProject(dir);
  const { contract } = await api(project, "PUT", "/contracts", { path: CONTRACT, content: ORIGINAL, updatedBy: "e2e", format: "json-schema" });
  await api(project, "POST", `/contracts/${contract.id}/consumers`, { path: "src/uses-user.ts", agentId: null, declared: true });

  const invocation = (force) => harnessCommand({ harness, prompt: PROMPT, dir, force, fake, codexHome });

  // 1. Without the override the hook must block, leaving the file untouched.
  const [cmd, args, opts] = invocation(false);
  if (fake) fake.requests.length = 0;
  const blocked = await runAsync(cmd, args, { cwd: dir, ...opts });
  const afterBlock = readFileSync(join(dir, CONTRACT), "utf8");
  // In fake mode the strongest evidence is what the harness sent BACK to the model: the tool result must
  // carry the hook's deny text. Appending it lets the checks below see it like any other output.
  const blockOutput =
    (blocked.stdout ?? "") + (blocked.stderr ?? "") + (fake ? `\n[requests sent to the fake model]\n${JSON.stringify(fake.requests.map((r) => r.body))}` : "");
  if (process.env.KINGPOST_E2E_DEBUG) writeFileSync("/tmp/e2e-block-output.txt", blockOutput);
  console.log(`[${harness}] block run exit=${blocked.status}, tools used: ${toolsUsed(harness, blockOutput)}\n${blockOutput.slice(-1500)}`);
  if (!fakeMode) console.log(costSummary(harness, blockOutput));
  if (afterBlock !== ORIGINAL) fail(`the breaking edit was NOT blocked: the contract changed on disk (tools used: ${toolsUsed(harness, blockOutput)})`, blockOutput);
  // An unchanged file alone proves nothing: the model may have stopped, or fumbled the patch, before
  // the hook ever ran. Require the hook's own deny text to have reached the harness.
  if (!blockOutput.includes("Breaking change to `contracts/user.json`")) {
    fail("the file is unchanged, but there's no sign the Kingpost hook is what stopped the edit", blockOutput.slice(-3000));
  }

  // 2. Control: with KINGPOST_FORCE=1 the same request must go through.
  const [cmd2, args2, opts2] = invocation(true);
  const forced = await runAsync(cmd2, args2, { cwd: dir, ...opts2 });
  if (!fakeMode) console.log(costSummary(harness, (forced.stdout ?? "") + (forced.stderr ?? "")));
  const afterForce = readFileSync(join(dir, CONTRACT), "utf8");
  console.log(`[${harness}] force run exit=${forced.status}, tools used: ${toolsUsed(harness, (forced.stdout ?? "") + (forced.stderr ?? ""))}\n${(forced.stdout ?? "").slice(-800)}`);
  if (afterForce === ORIGINAL || JSON.parse(afterForce).properties.age !== undefined) {
    fail("control run: with KINGPOST_FORCE=1 the edit still didn't happen, so the block run proves nothing", (forced.stdout ?? "") + (forced.stderr ?? ""));
  }

  console.log(`PASS [${harness}, ${fakeMode ? "fake" : "real"} model]: breaking edit blocked, and allowed with KINGPOST_FORCE=1`);
} catch (e) {
  reportFailure(harness, e);
  process.exitCode = 1;
} finally {
  await deleteProject(harness, project);
  await fake?.close();
  rmSync(dir, { recursive: true, force: true });
  if (codexHome) rmSync(codexHome, { recursive: true, force: true });
}
process.exit(process.exitCode ?? 0);

// What happens when a contract is changed by a SHELL command (`sed -i`, `cat >`, a script) instead of the agent's
// edit tool? Kingpost can't see that coming, so it can't block it; but after the command it must notice, record
// the change in the registry, and tell the agent. With a real harness and the scripted model:
//
//   1. a shell command rewrites the contract in a breaking way. It is NOT blocked (the file changes), but the
//      registry gets the new version marked breaking, and the agent is told it bypassed the check and who it affects.
//   2. a later shell command puts the OLD content back (what a checkout that is behind a teammate looks like).
//      Nothing is published: content the registry already holds must never be republished as new.
//
//   node scripts/e2e-shell.mjs <claude|codex>
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startFakeModel } from "./fake-model/server.mjs";
import {
  api, deleteProject, fail, fakeMode, harnessCommand, loadProject, makeTempDir, prepareCodexHome, reportFailure, runAsync, runKingpost, server,
} from "./e2e-lib.mjs";

const harness = process.argv[2];
if (harness !== "claude" && harness !== "codex") {
  console.error("usage: node scripts/e2e-shell.mjs <claude|codex>");
  process.exit(2);
}
if (!fakeMode) {
  console.error("e2e-shell.mjs only supports the scripted model (KINGPOST_E2E_MODEL=fake)");
  process.exit(2);
}

const label = `shell/${harness}`;
const CONTRACT = "contracts/user.json";
const V1 = JSON.stringify({ type: "object", properties: { name: { type: "string" }, age: { type: "number" } }, required: ["name"] }) + "\n";
const V2 = JSON.stringify({ type: "object", properties: { name: { type: "string" } }, required: ["name"] }) + "\n"; // drops age: breaking

const dir = makeTempDir(`kp-e2e-shell-${harness}-`);
let fake;
let codexHome;
let project;

function expect(cond, msg, detail) {
  if (!cond) fail(msg, detail);
  console.log(`  ok: ${msg.replace(/^expected /, "")}`);
}

// One shell command, run by the real harness; returns what the harness sent back to the (scripted) model.
async function shellSession(command, prompt) {
  fake.requests.length = 0;
  fake.setSteps({
    claudeSteps: [{ tool: "Bash", input: { command, description: "rewrite the contract" } }, { text: "Done." }],
    codexSteps: [{ tool: "exec_command", input: { cmd: command } }, { text: "Done." }],
  });
  const [cmd, args, opts] = harnessCommand({ harness, prompt, dir, fake, codexHome, shell: true });
  const run = await runAsync(cmd, args, { cwd: dir, ...opts });
  const sent = JSON.stringify(fake.requests.map((r) => r.body));
  console.log(`[${label}] "${command}" exit=${run.status}`);
  return { run, sent, output: (run.stdout ?? "") + (run.stderr ?? "") };
}

const onDisk = () => readFileSync(join(dir, CONTRACT), "utf8");
const latest = async (contractId) => (await api(project, "GET", `/contracts/${contractId}`));

try {
  fake = await startFakeModel();
  mkdirSync(join(dir, "contracts"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, CONTRACT), V1);
  writeFileSync(join(dir, "src/uses-user.ts"), `import type { User } from "../contracts/user.json";\nexport const u: User | null = null;\n`);
  // Plain node scripts, so the shell command has no quoting to get wrong on any OS.
  writeFileSync(join(dir, "rewrite.js"), `require("fs").writeFileSync(${JSON.stringify(CONTRACT)}, ${JSON.stringify(V2)});\n`);
  writeFileSync(join(dir, "restore.js"), `require("fs").writeFileSync(${JSON.stringify(CONTRACT)}, ${JSON.stringify(V1)});\n`);
  if (harness === "codex") codexHome = prepareCodexHome([dir], fake.url);

  const init = runKingpost(["init", "--name", `e2e-shell-${harness}-${Date.now()}`, "--server-url", server], { cwd: dir });
  if (init.status !== 0) fail("kingpost init failed", init.stdout + init.stderr);
  project = loadProject(dir);
  const { contract } = await api(project, "PUT", "/contracts", { path: CONTRACT, content: V1, updatedBy: "e2e", format: "json-schema" });
  await api(project, "POST", `/contracts/${contract.id}/consumers`, { path: "src/uses-user.ts", agentId: null, declared: true });

  // 1. A breaking rewrite by shell command.
  const first = await shellSession("node rewrite.js", "Run the rewrite script.");
  expect(onDisk() === V2, "expected the shell write to go through (Kingpost cannot block a shell command)", onDisk());
  const afterFirst = await latest(contract.id);
  expect(afterFirst.contract.currentVersion === 2 && afterFirst.versions[0].content === V2, "expected the shell-written contract to be recorded in the registry as v2", JSON.stringify(afterFirst.versions[0]));
  expect(afterFirst.versions[0].breaking === true, "expected that version to be marked breaking", JSON.stringify(afterFirst.versions[0]));
  expect(first.sent.includes(`${CONTRACT} was changed by a shell command`), "expected the agent to be told the contract was changed by a shell command", first.output.slice(-2500));
  expect(first.sent.includes("BREAKING") && first.sent.includes("src/uses-user.ts"), "expected the agent to be told it is breaking and which consumer it affects", first.output.slice(-2500));

  // 2. The old content comes back (a checkout behind the registry): it must not be published as new.
  const second = await shellSession("node restore.js", "Run the restore script.");
  expect(onDisk() === V1, "expected the restore script to put the old content back on disk", onDisk());
  const afterSecond = await latest(contract.id);
  expect(afterSecond.contract.currentVersion === 2 && afterSecond.versions.length === 2, "expected content the registry already holds not to be republished as a new version", JSON.stringify(afterSecond.versions.map((v) => v.version)));
  expect(!second.sent.includes("was changed by a shell command"), "expected the agent not to be told about a change when nothing new reached the registry", second.sent.slice(-1500));

  console.log(`PASS [${label}, fake model]: shell write not blocked but recorded as breaking and reported; stale content not republished`);
} catch (e) {
  reportFailure(label, e);
  process.exitCode = 1;
} finally {
  await deleteProject(label, project);
  await fake?.close();
  rmSync(dir, { recursive: true, force: true });
  if (codexHome) rmSync(codexHome, { recursive: true, force: true });
}
process.exit(process.exitCode ?? 0);

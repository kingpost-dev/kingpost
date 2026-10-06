// End-to-end check of Kingpost's team features with two REAL agent sessions (Claude Code or Codex) sharing one
// real Kingpost project. Alice and Bob are separate directories, joined to the same project, each running
// in the real harness with Kingpost's real hooks and MCP server:
//
//   1. alice  sets her status and claims, asks the team a question, publishes a finding, and writes a new
//             contract file (which the PostToolUse hook must publish to the registry)
//   2. bob    starts a session (his brief must show alice's open question and the contract), lists teammates,
//             and answers the question
//   3. alice  starts another session: bob's answer must be delivered to her
//
//   node scripts/e2e-team.mjs <claude|codex>
//
// Scripted model by default, real model with KINGPOST_E2E_MODEL=real (see e2e-lib.mjs). In real mode the
// model is only told what to do in plain words, so it can fail for model reasons; fake mode is the reliable one.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { startFakeModel } from "./fake-model/server.mjs";
import {
  api, cliEntry, deleteProject, fail, fakeMode, harnessCommand, loadProject, makeTempDir, prepareCodexHome, reportFailure,
  runAsync, runSync, server,
} from "./e2e-lib.mjs";

const harness = process.argv[2];
if (harness !== "claude" && harness !== "codex") {
  console.error("usage: node scripts/e2e-team.mjs <claude|codex>");
  process.exit(2);
}
if (!fakeMode) {
  console.error("e2e-team.mjs only supports the scripted model for now (KINGPOST_E2E_MODEL=fake)");
  process.exit(2);
}

const QUESTION = "Which auth scheme should login use?";
const ANSWER = "Use OAuth with PKCE";
const FINDING = "Login rate limit is 5 per minute";
const STATUS = "building the login flow";
const NEW_CONTRACT = "contracts/api.json";
const NEW_CONTRACT_BODY = '{"type":"object","properties":{"id":{"type":"string"}}}';

// One generic step list per agent session, rendered for either harness's tool vocabulary.
const mcp = (tool, input) => ({ mcp: tool, input });
const writeFile = (rel, content) => ({ write: { rel, content } });
const say = (text) => ({ text });
function render(steps, dir) {
  const claudeSteps = steps.map((s) =>
    s.mcp ? { tool: `mcp__kingpost__${s.mcp}`, input: s.input }
    : s.write ? { tool: "Write", input: { file_path: join(dir, s.write.rel), content: s.write.content } }
    : s
  );
  const codexSteps = steps.map((s) =>
    s.mcp ? { tool: s.mcp, namespace: "mcp__kingpost", input: s.input }
    : s.write ? { tool: "apply_patch", input: `*** Begin Patch\n*** Add File: ${s.write.rel}\n+${s.write.content}\n*** End Patch\n` }
    : s
  );
  return { claudeSteps, codexSteps };
}

const dirAlice = makeTempDir(`kp-e2e-team-alice-${harness}-`);
const dirBob = makeTempDir(`kp-e2e-team-bob-${harness}-`);
console.log(`[team/${harness}] alice: ${dirAlice}\n[team/${harness}] bob:   ${dirBob}`);
let fake;
let codexHome;
let project;

// Runs one agent session and returns everything the harness sent to the (scripted) model, which is where
// hook-injected context and MCP tool results show up.
async function session(name, dir, steps, prompt) {
  fake.requests.length = 0;
  fake.setSteps(render(steps, dir));
  const [cmd, args, opts] = harnessCommand({ harness, prompt, dir, agentName: name, fake, codexHome, mcp: true });
  const run = await runAsync(cmd, args, { cwd: dir, ...opts });
  const sent = JSON.stringify(fake.requests.map((r) => r.body));
  console.log(`[team/${harness}] ${name} session exit=${run.status}`);
  return { run, sent, output: (run.stdout ?? "") + (run.stderr ?? "") };
}

function expect(cond, msg, detail) {
  if (!cond) fail(msg, detail);
  console.log(`  ok: ${msg.replace(/^expected /, "")}`);
}

try {
  fake = await startFakeModel();
  mkdirSync(join(dirAlice, "contracts"));
  if (harness === "codex") codexHome = prepareCodexHome([dirAlice, dirBob], fake.url);

  const init = runSync("node", [cliEntry, "init", "--name", `e2e-team-${harness}-${Date.now()}`, "--server-url", server], { cwd: dirAlice });
  if (init.status !== 0) fail("kingpost init failed", init.stdout + init.stderr);
  project = loadProject(dirAlice);
  const link = `${project.config.serverUrl}/join/${project.config.projectId}#${project.token}`;
  const join_ = runSync("node", [cliEntry, "join", link, "--name", "bob"], { cwd: dirBob });
  if (join_.status !== 0) fail("kingpost join failed", join_.stdout + join_.stderr);

  // 1. alice
  const a1 = await session(
    "alice",
    dirAlice,
    [
      mcp("kingpost_status", { text: STATUS, claims: ["src/login.ts"] }),
      mcp("kingpost_ask", { question: QUESTION }),
      mcp("kingpost_finding", { text: FINDING, paths: ["src/login.ts"] }),
      writeFile(NEW_CONTRACT, NEW_CONTRACT_BODY),
      say("Done."),
    ],
    "Set your status, ask the team a question, publish a finding, and add a contract file."
  );
  const { agents } = await api(project, "GET", "/agents");
  const alice = agents.find((a) => a.userName === "alice");
  expect(alice, "expected alice to be registered as an agent (SessionStart hook)", a1.output);
  expect(alice.statusText === STATUS && alice.claims.includes("src/login.ts"), "expected alice's status and claims to reach the server (kingpost_status)", JSON.stringify(alice));
  expect(alice.harness === harness, `expected alice's agent to be recorded as harness ${harness}`, JSON.stringify(alice));
  const { questions } = await api(project, "GET", "/questions");
  const question = questions.find((q) => q.text === QUESTION);
  expect(question && question.status === "open", "expected alice's question to be open on the server (kingpost_ask)", JSON.stringify(questions));
  const { findings } = await api(project, "GET", "/findings");
  expect(findings.some((f) => f.text === FINDING), "expected alice's finding to be published (kingpost_finding)", JSON.stringify(findings));
  const { contracts } = await api(project, "GET", "/contracts");
  expect(contracts.some((c) => c.path === NEW_CONTRACT), `expected ${NEW_CONTRACT} to be published to the registry by the PostToolUse hook`, a1.output + JSON.stringify(contracts));

  // 2. bob
  const b1 = await session(
    "bob",
    dirBob,
    [mcp("kingpost_who", {}), mcp("kingpost_answer", { questionId: question.id, text: ANSWER }), say("Done.")],
    "List the teammates and answer the open question."
  );
  expect(b1.sent.includes(QUESTION), "expected bob's session-start brief to show alice's open question (hook context injection)", b1.sent.slice(0, 2000));
  expect(b1.sent.includes(NEW_CONTRACT), "expected bob's brief to list the contract alice published", b1.sent.slice(0, 2000));
  expect(b1.sent.includes(STATUS), "expected bob to see alice's status via the brief or kingpost_who", b1.sent.slice(0, 2000));
  const after = (await api(project, "GET", "/questions")).questions.find((q) => q.id === question.id);
  expect(after.status === "answered", "expected bob's answer to mark the question answered (kingpost_answer)", JSON.stringify(after));

  // 3. alice again: the answer must reach her.
  const a2 = await session("alice", dirAlice, [mcp("kingpost_brief", {}), say("Done.")], "Check the team brief.");
  expect(a2.sent.includes(ANSWER), "expected bob's answer to be delivered to alice in her next session", a2.sent.slice(0, 2000));

  console.log(`PASS [team/${harness}, fake model]: status/claims, ask, finding, contract publish, brief injection, answer, delivery`);
} catch (e) {
  reportFailure(`team/${harness}`, e);
  process.exitCode = 1;
} finally {
  await deleteProject(`team/${harness}`, project);
  await fake?.close();
  rmSync(dirAlice, { recursive: true, force: true });
  rmSync(dirBob, { recursive: true, force: true });
  if (codexHome) rmSync(codexHome, { recursive: true, force: true });
}
process.exit(process.exitCode ?? 0);

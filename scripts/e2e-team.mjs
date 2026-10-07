// End-to-end check of Kingpost's team features with two REAL agent sessions (Claude Code or Codex) sharing one
// real Kingpost project. Alice and Bob are separate directories, joined to the same project, each running
// in the real harness with Kingpost's real hooks and MCP server:
//
//   1. alice  sets her status and claims, asks the team a question, publishes a finding, and writes a new
//             contract file (which the PostToolUse hook must publish to the registry)
//   2. bob    starts a session (his brief must show alice's open question and the contract), lists teammates,
//             and answers the question
//   3. alice  starts another session: bob's answer must be delivered to her, and her brief must show the file
//             bob has claimed (the same one she claimed)
//   4. bob    proposes a breaking change to alice's contract
//   5. alice  sees the proposal at session start, accepts it, and hands the contract to bob
//   6. bob    sees the new contract version at session start, then edits the contract: allowed through (it
//             isn't breaking) and published as the next version. Bob now owns the contract.
//   7. alice  proposes a change to it (P2)
//   8. bob    (the owner) sees P2 at session start, reads it, and replies asking for a tweak
//   9. alice  sees bob's reply at session start and replies back
//  10. bob    sees alice's reply, then rejects P2 with a reason
//  11. alice  sees the rejection (and its reason) at session start, then proposes a better change (P3)
//  12. bob    accepts P3
//  13. alice  is told her proposal was accepted (the proposer is notified, not only owner and consumers)
//
// Not covered here: the PreToolUse "claims overlap" / "contract changed recently" advisories. Those use a
// cache that each prompt's delta overwrites, and a headless session has no gap between SessionStart and its
// one prompt in which a teammate's change could land, so they stay covered by the unit tests.
//
//   node scripts/e2e-team.mjs <claude|codex>
//
// Scripted model by default, real model with KINGPOST_E2E_MODEL=real (see e2e-lib.mjs). In real mode the
// model is only told what to do in plain words, so it can fail for model reasons; fake mode is the reliable one.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startFakeModel } from "./fake-model/server.mjs";
import {
  api, deleteProject, fail, fakeMode, harnessCommand, loadProject, makeTempDir, prepareCodexHome, reportFailure,
  runAsync, runKingpost, server,
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
const PROPOSED_BODY = '{"type":"object","properties":{}}'; // removes id: breaking for any consumer
const FOLLOWUP_BODY = '{"type":"object","properties":{"label":{"type":"string"}}}'; // adds an optional field: not breaking
const RATIONALE = "drop the id field";
const P2_BODY = '{"type":"object","properties":{"label":{"type":"string"},"id":{"type":"number"}}}';
const P3_BODY = '{"type":"object","properties":{"label":{"type":"string"},"note":{"type":"string"}}}';

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
let sessionCount = 0;
let lastSession; // appended to every failure: what the harness told the model about each tool call

// Runs one agent session and returns everything the harness sent to the (scripted) model, which is where
// hook-injected context and MCP tool results show up.
async function session(name, dir, steps, prompt) {
  fake.requests.length = 0;
  fake.setSteps(render(steps, dir));
  const [cmd, args, opts] = harnessCommand({ harness, prompt, dir, agentName: name, fake, codexHome, mcp: true });
  const run = await runAsync(cmd, args, { cwd: dir, ...opts });
  const sent = JSON.stringify(fake.requests.map((r) => r.body));
  console.log(`[team/${harness}] ${name} session exit=${run.status}`);
  const offered = fake.requests.map((r) => r.body.tools).find((t) => Array.isArray(t));
  const toolsOffered = (offered ?? []).filter((t) => t.type === "namespace").map((t) => `${t.name}[${(t.tools ?? []).map((x) => x.name).join(",")}]`).join(" ") || "(no namespace tools offered)";
  lastSession = { name, status: run.status, sent, toolsOffered };
  if (process.env.KINGPOST_E2E_DEBUG) writeFileSync(`/tmp/e2e-team-${harness}-${name}-${++sessionCount}.json`, sent);
  return { run, sent, output: (run.stdout ?? "") + (run.stderr ?? "") };
}

// What the harness reported back to the model for each tool call: the quickest way to see why a tool did nothing.
function toolResults(sent) {
  const hits = [...sent.matchAll(/(?:"output":"|"type":"tool_result","content":\[\{"type":"text","text":")([^"]{0,300})/g)].map((m) => m[1]);
  return hits.slice(-8).join("\n  - ");
}

// The hook-injected context sits deep inside the first request body; show the part around the brief.
function excerpt(sent) {
  const at = sent.indexOf("Kingpost brief");
  return at < 0 ? `(no "Kingpost brief" in what was sent) ${sent.slice(0, 1500)}` : sent.slice(Math.max(0, at - 200), at + 2000);
}

function expect(cond, msg, detail) {
  if (!cond) {
    const last = lastSession ? `\n--- last session (${lastSession.name}, exit ${lastSession.status}) tool results ---\n  - ${toolResults(lastSession.sent)}\nMCP tools Codex offered: ${lastSession.toolsOffered}` : "";
    fail(msg, `${detail ?? ""}${last}`);
  }
  console.log(`  ok: ${msg.replace(/^expected /, "")}`);
}

try {
  fake = await startFakeModel();
  mkdirSync(join(dirAlice, "contracts"));
  if (harness === "codex") codexHome = prepareCodexHome([dirAlice, dirBob], fake.url);

  const init = runKingpost(["init", "--name", `e2e-team-${harness}-${Date.now()}`, "--server-url", server], { cwd: dirAlice });
  if (init.status !== 0) fail("kingpost init failed", init.stdout + init.stderr);
  project = loadProject(dirAlice);
  const link = `${project.config.serverUrl}/join/${project.config.projectId}#${project.token}`;
  const join_ = runKingpost(["join", link, "--name", "bob"], { cwd: dirBob });
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
    [
      mcp("kingpost_who", {}),
      mcp("kingpost_answer", { questionId: question.id, text: ANSWER }),
      // Claimed AFTER alice claimed the same path: alice is the one who gets told about the overlap.
      mcp("kingpost_status", { text: "also touching login", claims: ["src/login.ts"] }),
      say("Done."),
    ],
    "List the teammates, answer the open question, and set your status."
  );
  expect(b1.sent.includes(QUESTION), "expected bob's session-start brief to show alice's open question (hook context injection)", excerpt(b1.sent));
  expect(b1.sent.includes(NEW_CONTRACT), "expected bob's brief to list the contract alice published", excerpt(b1.sent));
  expect(b1.sent.includes(STATUS), "expected bob to see alice's status via the brief or kingpost_who", excerpt(b1.sent));
  const after = (await api(project, "GET", "/questions")).questions.find((q) => q.id === question.id);
  expect(after.status === "answered", "expected bob's answer to mark the question answered (kingpost_answer)", JSON.stringify(after));

  // 3. alice again: the answer must reach her.
  const a2 = await session(
    "alice",
    dirAlice,
    [mcp("kingpost_brief", {}), say("Done.")],
    "Check the team brief."
  );
  expect(a2.sent.includes(ANSWER), "expected bob's answer to be delivered to alice in her next session", excerpt(a2.sent));
  expect(
    a2.sent.includes(`bob [${harness}]: also touching login (claims: src/login.ts)`),
    "expected alice's brief to show the file bob claimed (the one she claimed too)",
    excerpt(a2.sent)
  );

  // 4. bob proposes a breaking change to alice's contract
  const apiContract = (await api(project, "GET", "/contracts")).contracts.find((c) => c.path === NEW_CONTRACT);
  const b2 = await session(
    "bob",
    dirBob,
    [mcp("kingpost_propose", { contractId: apiContract.id, newContent: PROPOSED_BODY, rationale: RATIONALE }), say("Done.")],
    "Propose dropping the id field from the api contract."
  );
  const proposalId = b2.sent.match(/Proposal \[(proposal_[a-z0-9]+)\] created/)?.[1];
  expect(proposalId, "expected bob's kingpost_propose to return a proposal id", b2.sent.slice(-2000));

  // 5. alice accepts it
  const a3 = await session(
    "alice",
    dirAlice,
    [mcp("kingpost_accept", { proposalId }), mcp("kingpost_transfer", { contractId: apiContract.id, toUserName: "bob" }), say("Done.")],
    "Accept the proposal and hand the contract to bob."
  );
  expect(a3.sent.includes(`Proposal for you: [${proposalId}]`) && a3.sent.includes(RATIONALE), "expected alice's session start to show bob's proposal (the owner is told)", excerpt(a3.sent));
  const detail = await api(project, "GET", `/contracts/${apiContract.id}`);
  expect(detail.versions[0].version === 2 && detail.versions[0].content === PROPOSED_BODY, "expected accepting the proposal to publish its content as v2 (kingpost_accept)", `${JSON.stringify(detail.versions[0])}\nalice's tool results:\n  - ${toolResults(a3.sent)}\nexit=${a3.run.status}\n${a3.output.slice(-1200)}`);
  expect(detail.contract.ownerUserName === "bob", "expected kingpost_transfer to make bob the contract's owner", JSON.stringify(detail.contract));

  // 6. bob sees the acceptance and edits the contract
  const b3 = await session(
    "bob",
    dirBob,
    [writeFile(NEW_CONTRACT, FOLLOWUP_BODY), say("Done.")],
    "Add a label field to the api contract."
  );
  expect(b3.sent.includes(`${NEW_CONTRACT} v2 (by bob)`), "expected bob's brief to show the contract at v2, now owned by him", excerpt(b3.sent));
  const final = await api(project, "GET", `/contracts/${apiContract.id}`);
  expect(// Codex's apply_patch ends the files it creates with a newline, Claude's Write doesn't.
    final.contract.currentVersion === 3 && final.versions[0].content.trim() === FOLLOWUP_BODY, "expected bob's non-breaking edit to be allowed and published as v3", JSON.stringify(final.versions[0]) + `\nalice config: ${readFileSync(join(dirAlice, ".kingpost.json"), "utf8")}\nbob config: ${readFileSync(join(dirBob, ".kingpost.json"), "utf8")}\nproject: ${project.config.projectId}` + b3.output.slice(-1500));

  // 7-13: discussion, rejection, and a proposal that is accepted, with everyone related kept informed.
  const proposalIdFrom = (sent) => sent.match(/Proposal \[(proposal_[a-z0-9]+)\] created/)?.[1];
  const a4 = await session(
    "alice",
    dirAlice,
    [mcp("kingpost_propose", { contractId: apiContract.id, newContent: P2_BODY, rationale: "add a numeric id back" }), say("Done.")],
    "Propose adding a numeric id to the api contract."
  );
  const p2 = proposalIdFrom(a4.sent);
  expect(p2, "expected alice's second kingpost_propose to return a proposal id", a4.sent.slice(-1500));

  const b4 = await session(
    "bob",
    dirBob,
    [mcp("kingpost_proposal", { proposalId: p2 }), mcp("kingpost_reply", { proposalId: p2, text: "can you keep label optional?" }), say("Done.")],
    "Read the proposal and ask for a tweak."
  );
  expect(b4.sent.includes(`Proposal for you: [${p2}]`), "expected bob, the owner, to be told about alice's proposal at session start", excerpt(b4.sent));
  expect(b4.sent.includes("add a numeric id back") && b4.sent.includes("Replies:"), "expected kingpost_proposal to show the proposal's rationale and thread", toolResults(b4.sent));

  const a5 = await session(
    "alice",
    dirAlice,
    [mcp("kingpost_reply", { proposalId: p2, text: "yes, label stays optional" }), say("Done.")],
    "Reply to bob about the proposal."
  );
  expect(
    a5.sent.includes(`Reply on proposal [${p2}] (${NEW_CONTRACT}) from bob: can you keep label optional?`),
    "expected alice to be told about bob's reply at session start",
    excerpt(a5.sent)
  );

  const b5 = await session(
    "bob",
    dirBob,
    [mcp("kingpost_reject", { proposalId: p2, reason: "superseded by a smaller change" }), say("Done.")],
    "Reject the proposal."
  );
  expect(b5.sent.includes(`Reply on proposal [${p2}] (${NEW_CONTRACT}) from alice: yes, label stays optional`), "expected bob to be told about alice's reply at session start", excerpt(b5.sent));
  const closed = (await api(project, "GET", `/proposals/${p2}`)).proposal;
  expect(closed.status === "rejected" && closed.rejectionReason === "superseded by a smaller change", "expected kingpost_reject to close the proposal with its reason", JSON.stringify(closed));

  const a6 = await session(
    "alice",
    dirAlice,
    [mcp("kingpost_propose", { contractId: apiContract.id, newContent: P3_BODY, rationale: "smaller change" }), say("Done.")],
    "Propose the smaller change."
  );
  expect(
    a6.sent.includes(`Proposal rejected: [${p2}] change to ${NEW_CONTRACT} was turned down — superseded by a smaller change`),
    "expected alice, the proposer, to be told her proposal was rejected, with the reason",
    excerpt(a6.sent)
  );
  const p3 = proposalIdFrom(a6.sent);
  expect(p3 && p3 !== p2, "expected alice's third kingpost_propose to return a new proposal id", a6.sent.slice(-1500));

  const b6 = await session("bob", dirBob, [mcp("kingpost_accept", { proposalId: p3 }), say("Done.")], "Accept the proposal.");
  expect(b6.sent.includes(`Proposal for you: [${p3}]`), "expected bob to be told about the smaller proposal at session start", excerpt(b6.sent));
  const latest = await api(project, "GET", `/contracts/${apiContract.id}`);
  expect(latest.contract.currentVersion === 4 && latest.versions[0].content === P3_BODY, "expected accepting the smaller proposal to publish it as v4", JSON.stringify(latest.versions[0]));

  const a7 = await session("alice", dirAlice, [mcp("kingpost_brief", {}), say("Done.")], "Check the team brief.");
  expect(
    a7.sent.includes(`Proposal accepted: [${p3}] ${NEW_CONTRACT} is now v4`),
    "expected alice, the proposer, to be told her proposal was accepted",
    excerpt(a7.sent)
  );

  console.log(`PASS [team/${harness}, fake model]: status/claims, ask, finding, contract publish, brief injection, answer, delivery, claims in brief, propose, accept, transfer, non-breaking edit published, reply, reject, proposer notified`);
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

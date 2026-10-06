// A scripted stand-in for the model API, so the REAL Claude Code / Codex harnesses (hooks, MCP, approvals,
// tool plumbing) can be exercised with no API key, no cost, and no model nondeterminism. What the "model"
// says is irrelevant to Kingpost; only the tool calls the harness then makes matter.
//
// A script is a list of steps: { tool, input } makes the model call a tool, { text } ends the turn.
// The step to play is derived from how many tool results the harness has already sent back, so the
// server holds no per-conversation state.
import { createServer } from "node:http";

const sse = (res, events) => {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
};

let counter = 0;
const id = (prefix) => `${prefix}_${Date.now().toString(36)}${(counter++).toString(36)}`;

// ---- Anthropic Messages API (Claude Code) ----
function anthropicStream(res, model, step) {
  const msgId = id("msg");
  const usage = { input_tokens: 10, output_tokens: 10 };
  const events = [["message_start", { type: "message_start", message: { id: msgId, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage } }]];
  if (step.tool) {
    events.push(
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: id("toolu"), name: step.tool, input: {} } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(step.input) } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 10 } }]
    );
  } else {
    events.push(
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: step.text } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } }]
    );
  }
  events.push(["message_stop", { type: "message_stop" }]);
  sse(res, events);
}

function countAnthropicToolResults(messages) {
  let n = 0;
  for (const m of messages ?? []) {
    if (Array.isArray(m.content)) n += m.content.filter((b) => b.type === "tool_result").length;
  }
  return n;
}

// ---- OpenAI Responses API (Codex) ----
// Codex's tool set comes from its model catalog (see codex-catalog.json): that fake model gets the
// freeform `apply_patch` tool and `exec_command`. A step's `input` is the raw patch text for apply_patch
// and an object for function tools.
function responsesStream(res, step) {
  const respId = id("resp");
  const events = [["response.created", { type: "response.created", response: { id: respId } }]];
  let item;
  if (step.tool === "apply_patch") {
    item = { type: "custom_tool_call", id: id("ctc"), call_id: id("call"), name: "apply_patch", input: step.input };
  } else if (step.tool) {
    // MCP tools are offered in a namespace (mcp__<server>) and must be called with it plus the bare name.
    item = { type: "function_call", id: id("fc"), call_id: id("call"), name: step.tool, arguments: JSON.stringify(step.input), ...(step.namespace ? { namespace: step.namespace } : {}) };
  } else {
    item = { type: "message", id: id("msg"), role: "assistant", content: [{ type: "output_text", text: step.text }] };
  }
  const added = item.type === "message" ? { ...item, content: [] } : item.type === "function_call" ? { ...item, arguments: "" } : { ...item, input: "" };
  events.push(
    ["response.output_item.added", { type: "response.output_item.added", output_index: 0, item: added }],
    ["response.output_item.done", { type: "response.output_item.done", output_index: 0, item }],
    ["response.completed", { type: "response.completed", response: { id: respId, usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } } }]
  );
  sse(res, events);
}

function countResponsesToolOutputs(input) {
  return (input ?? []).filter((i) => i.type === "function_call_output" || i.type === "custom_tool_call_output").length;
}

export async function startFakeModel(initial = {}) {
  // The scripts can be swapped between agent sessions with setSteps().
  let scripts = { claudeSteps: initial.claudeSteps ?? [], codexSteps: initial.codexSteps ?? [] };
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let json = {};
      try { json = body ? JSON.parse(body) : {}; } catch { /* non-JSON request */ }
      requests.push({ method: req.method, url: req.url, body: json });

      if (req.method === "POST" && req.url.startsWith("/v1/messages/count_tokens")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ input_tokens: 10 }));
      }
      if (req.method === "POST" && req.url.startsWith("/v1/messages")) {
        // Claude Code also makes small side requests (titles, quota probes) with no tools; answer those
        // with plain text and keep the scripted steps for the main conversation.
        const isMain = Array.isArray(json.tools) && json.tools.length > 0;
        const step = isMain ? scripts.claudeSteps[Math.min(countAnthropicToolResults(json.messages), scripts.claudeSteps.length - 1)] : { text: "ok" };
        if (json.stream === false) {
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(JSON.stringify({
            id: id("msg"), type: "message", role: "assistant", model: json.model ?? "fake",
            content: step.tool ? [{ type: "tool_use", id: id("toolu"), name: step.tool, input: step.input }] : [{ type: "text", text: step.text }],
            stop_reason: step.tool ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 },
          }));
        }
        return anthropicStream(res, json.model ?? "fake", step);
      }
      if (req.method === "POST" && req.url.includes("/responses")) {
        const isMain = Array.isArray(json.tools) && json.tools.length > 0;
        const step = isMain ? scripts.codexSteps[Math.min(countResponsesToolOutputs(json.input), scripts.codexSteps.length - 1)] : { text: "ok" };
        return responsesStream(res, step);
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `fake model: no handler for ${req.method} ${req.url}` } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    setSteps: (next) => { scripts = { claudeSteps: next.claudeSteps ?? scripts.claudeSteps, codexSteps: next.codexSteps ?? scripts.codexSteps }; },
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}

import type { Agent, Contract, ContractVersion, Consumer, Question, Answer, Finding, Delta, Proposal } from "@kingpost/protocol";

const TIMEOUT_MS = 1500;

export class ApiClient {
  constructor(private serverUrl: string, private projectId: string, private token: string, private timeoutMs: number = TIMEOUT_MS) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.serverUrl}/api/projects/${this.projectId}${path}`, {
        ...init,
        signal: controller.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.token}`, ...init?.headers },
      });
      if (!res.ok) throw new Error(`kingpost server returned ${res.status}`);
      return (await res.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  registerAgent(body: { userName: string; harness: string; cwd: string }) {
    return this.request<{ agent: Agent }>("/agents", { method: "POST", body: JSON.stringify(body) });
  }

  updateStatus(agentId: string, body: { statusText: string; claims: string[] }) {
    return this.request<{ agent: Agent }>(`/agents/${agentId}/status`, { method: "POST", body: JSON.stringify(body) });
  }

  getDelta(agentId: string) {
    return this.request<{ delta: Delta; cursor: number }>(`/events/agents/${agentId}/delta`, { method: "GET" });
  }

  publishContract(body: { path: string; content: string; updatedBy: string; format?: string; breaking?: boolean; diffSummary?: string }) {
    return this.request<{ contract: Contract; version: ContractVersion; changed: boolean }>("/contracts", { method: "PUT", body: JSON.stringify(body) });
  }

  askQuestion(body: { fromAgentId: string; toAgentId: string | null; text: string }) {
    return this.request<{ question: Question }>("/questions", { method: "POST", body: JSON.stringify(body) });
  }

  answerQuestion(id: string, body: { text: string; byAgentId?: string; byUserName?: string }) {
    return this.request<{ answer: Answer; question: Question }>(`/questions/${id}/answers`, { method: "POST", body: JSON.stringify(body) });
  }

  publishFinding(body: { agentId: string; text: string; paths?: string[] }) {
    return this.request<{ finding: Finding }>("/findings", { method: "POST", body: JSON.stringify(body) });
  }

  listAgents() {
    return this.request<{ agents: Agent[] }>("/agents", { method: "GET" });
  }

  listQuestions() {
    return this.request<{ questions: Question[] }>("/questions", { method: "GET" });
  }

  listFindings() {
    return this.request<{ findings: Finding[] }>("/findings", { method: "GET" });
  }

  listContracts() {
    return this.request<{ contracts: Contract[] }>("/contracts", { method: "GET" });
  }

  getContract(id: string) {
    return this.request<{ contract: Contract; versions: ContractVersion[] }>(`/contracts/${id}`, { method: "GET" });
  }

  declareConsumer(contractId: string, body: { path: string; agentId: string | null; declared?: boolean }) {
    return this.request<{ consumer: Consumer }>(`/contracts/${contractId}/consumers`, { method: "POST", body: JSON.stringify(body) });
  }

  transferContract(id: string, toUserName: string) {
    return this.request<{ contract: Contract }>(`/contracts/${id}/transfer`, { method: "POST", body: JSON.stringify({ toUserName }) });
  }

  listConsumers(contractId: string) {
    return this.request<{ consumers: Consumer[] }>(`/contracts/${contractId}/consumers`, { method: "GET" });
  }

  proposeChange(contractId: string, body: { proposedByAgentId: string; newContent: string; rationale: string }) {
    return this.request<{ proposal: Proposal }>(`/contracts/${contractId}/proposals`, { method: "POST", body: JSON.stringify(body) });
  }

  acceptProposal(proposalId: string) {
    return this.request<{ proposal: Proposal; contract: Contract; version: ContractVersion }>(`/proposals/${proposalId}/accept`, { method: "POST" });
  }
}

// Deliberately NOT the 1500ms TIMEOUT_MS above: that budget exists so a hook can never noticeably
// slow an agent. This is a one-time, user-facing command, and a cold DNS/TLS handshake on a slow
// network (or a Windows machine, where node.exe's own spawn overhead is already 1-2s) can
// legitimately take longer than 1.5s — at which point `kingpost init` died with a raw undici stack.
const CREATE_PROJECT_TIMEOUT_MS = 15_000;

export async function createProject(serverUrl: string, name: string): Promise<{ projectId: string; token: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CREATE_PROJECT_TIMEOUT_MS);
  try {
    const res = await fetch(`${serverUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`kingpost server returned ${res.status} while creating the project`);
    return (await res.json()) as { projectId: string; token: string };
  } finally {
    clearTimeout(timeout);
  }
}

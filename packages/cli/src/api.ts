import type { Agent, Contract, ContractVersion, Consumer, Question, Answer, Finding, Delta } from "@kingpost/protocol";

const TIMEOUT_MS = 1500;

export class ApiClient {
  constructor(private serverUrl: string, private projectId: string, private token: string) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
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
}

export function createProject(serverUrl: string, name: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  return fetch(`${serverUrl}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
    signal: controller.signal,
  })
    .then((r) => r.json() as Promise<{ projectId: string; token: string }>)
    .finally(() => clearTimeout(timeout));
}

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
    return this.request<{ agent: any }>("/agents", { method: "POST", body: JSON.stringify(body) });
  }

  updateStatus(agentId: string, body: { statusText: string; claims: string[] }) {
    return this.request<{ agent: any }>(`/agents/${agentId}/status`, { method: "POST", body: JSON.stringify(body) });
  }

  getDelta(agentId: string) {
    return this.request<{ delta: any; cursor: number }>(`/events/agents/${agentId}/delta`, { method: "GET" });
  }

  publishContract(body: { path: string; content: string; updatedBy: string }) {
    return this.request<{ contract: any; changed: boolean }>("/contracts", { method: "PUT", body: JSON.stringify(body) });
  }

  askQuestion(body: { fromAgentId: string; toAgentId: string | null; text: string }) {
    return this.request<{ question: any }>("/questions", { method: "POST", body: JSON.stringify(body) });
  }

  answerQuestion(id: string, body: { text: string; byAgentId?: string; byUserName?: string }) {
    return this.request<{ answer: any; question: any }>(`/questions/${id}/answers`, { method: "POST", body: JSON.stringify(body) });
  }

  publishFinding(body: { agentId: string; text: string; paths?: string[] }) {
    return this.request<{ finding: any }>("/findings", { method: "POST", body: JSON.stringify(body) });
  }

  listAgents() {
    return this.request<{ agents: any[] }>("/agents", { method: "GET" });
  }

  listQuestions() {
    return this.request<{ questions: any[] }>("/questions", { method: "GET" });
  }

  listFindings() {
    return this.request<{ findings: any[] }>("/findings", { method: "GET" });
  }

  listContracts() {
    return this.request<{ contracts: any[] }>("/contracts", { method: "GET" });
  }
}

export function createProject(serverUrl: string, name: string) {
  return fetch(`${serverUrl}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  }).then((r) => r.json() as Promise<{ projectId: string; token: string }>);
}

import { runMcpServer } from "../mcp/server.js";

export async function mcpCommand(): Promise<void> {
  await runMcpServer(process.cwd());
}

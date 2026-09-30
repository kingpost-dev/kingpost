import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function log(message: string): void {
  try {
    const dir = join(homedir(), ".kingpost");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "log"), `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    // logging must never throw
  }
}

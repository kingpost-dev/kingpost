export function detectFormat(path: string, content: string): "json-schema" | "openapi" | "drizzle" | "unknown" {
  if (/\bpgTable\s*\(/.test(content)) return "drizzle";

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return "unknown";
  }
  if (typeof parsed !== "object" || parsed === null) return "unknown";
  const obj = parsed as Record<string, unknown>;

  if (typeof obj.openapi === "string" || typeof obj.swagger === "string") return "openapi";
  if (typeof obj.$schema === "string" && obj.$schema.includes("json-schema.org")) return "json-schema";
  if ("type" in obj || "properties" in obj) return "json-schema";
  return "unknown";
}

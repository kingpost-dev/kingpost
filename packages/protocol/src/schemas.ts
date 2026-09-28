import { z } from "zod";

export const HarnessSchema = z.enum(["claude", "codex"]);
export type Harness = z.infer<typeof HarnessSchema>;

export const AgentSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  userName: z.string(),
  harness: HarnessSchema,
  cwd: z.string(),
  statusText: z.string().default(""),
  claims: z.array(z.string()).default([]),
  lastSeen: z.string(), // ISO timestamp
  cursor: z.number().int().default(0),
});
export type Agent = z.infer<typeof AgentSchema>;

export const ContractSchema = z.object({
  path: z.string(),
  version: z.number().int(),
  contentSha256: z.string(),
  content: z.string().nullable(), // null when content exceeded the 64KB cap
  updatedBy: z.string(),
  updatedAt: z.string(),
});
export type Contract = z.infer<typeof ContractSchema>;

export const QuestionSchema = z.object({
  id: z.string(),
  fromAgentId: z.string(),
  toAgentId: z.string().nullable(), // null = whole team
  text: z.string(),
  status: z.enum(["open", "answered"]),
  createdAt: z.string(),
});
export type Question = z.infer<typeof QuestionSchema>;

export const AnswerSchema = z.object({
  id: z.string(),
  questionId: z.string(),
  text: z.string(),
  byAgentId: z.string().nullable(),
  byUserName: z.string().nullable(),
  createdAt: z.string(),
});
export type Answer = z.infer<typeof AnswerSchema>;

export const FindingSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  text: z.string(),
  paths: z.array(z.string()).default([]),
  createdAt: z.string(),
});
export type Finding = z.infer<typeof FindingSchema>;

export const EventPayloadSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("agent_registered"), agent: AgentSchema }),
  z.object({
    type: z.literal("agent_status"),
    agentId: z.string(),
    statusText: z.string(),
    claims: z.array(z.string()),
  }),
  z.object({ type: z.literal("contract_published"), contract: ContractSchema }),
  z.object({ type: z.literal("question_asked"), question: QuestionSchema }),
  z.object({ type: z.literal("question_answered"), answer: AnswerSchema, question: QuestionSchema }),
  z.object({ type: z.literal("finding_published"), finding: FindingSchema }),
]);
export type EventPayload = z.infer<typeof EventPayloadSchema>;

export const EventSchema = z.object({
  id: z.number().int(),
  projectId: z.string(),
  agentId: z.string().nullable(),
  userName: z.string().nullable(),
  createdAt: z.string(),
  payload: EventPayloadSchema,
});
export type Event = z.infer<typeof EventSchema>;

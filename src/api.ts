import type { OpenBotConnection } from "./connection.js";
import { OpenBotError } from "./connection.js";

// Shapes from docs/automation.md of nightly-labs/openbot (Local scripts API).

export interface Routine {
  id: string;
  name: string;
  active: boolean;
}

export interface Agent {
  id: string;
  name: string;
  routines: Routine[];
}

export type DeliveryStatus = "queued" | "starting" | "running" | "completed" | "failed" | "interrupted" | "cancelled";

export const ENDED_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "interrupted", "cancelled"]);

export interface MessageReceipt {
  messageId: string;
  deliveries: { id: string; recipientAgentId: string; status: DeliveryStatus; position: number | null }[];
}

export interface Delivery {
  id: string;
  status: DeliveryStatus;
  turnId: string | null;
  error: string | null;
  answer: string | null;
}

export interface RunReceipt {
  runId: string;
  deliveryId: string | null;
}

export interface AgentSettings {
  id: string;
  name: string;
  provider: string;
  model: string;
  reasoningEffort: string;
  providerAccountId: string | null;
}

export interface SettingsChange {
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  providerAccountId?: string | null;
}

export interface Question {
  id: string;
  header?: string;
  question: string;
  options: { label: string; description?: string }[] | null;
}

export interface PendingPrompt {
  requestId: string;
  requiresOpenBot: boolean;
  questions: Question[];
}

export interface PendingApproval {
  requestId: string;
  agentId: string;
  threadId: string;
  turnId: string;
  kind: string;
  command: string | null;
  cwd: string | null;
  reason: string | null;
  grantRoot: string | null;
  permissions: unknown;
}

export interface Pending {
  prompts: PendingPrompt[];
  approvals: PendingApproval[];
  browserTakeovers: { requestId: string; requiresOpenBot: true }[];
}

const seg = encodeURIComponent;

/** Thin typed wrapper over every route of the Local scripts API. */
export class OpenBotApi {
  constructor(private readonly conn: OpenBotConnection) {}

  listAgents(): Promise<Agent[]> {
    return this.conn.request("GET", "/v1/agents");
  }

  /** An agent ID, or the one agent with this name (case and outer spaces ignored). */
  async resolveAgent(reference: string): Promise<Agent> {
    const agents = await this.listAgents();
    const byId = agents.find((a) => a.id === reference);
    if (byId) return byId;
    const wanted = reference.trim().toLocaleLowerCase();
    const named = agents.filter((a) => a.name.trim().toLocaleLowerCase() === wanted);
    if (named.length === 1 && named[0]) return named[0];
    if (named.length > 1)
      throw new OpenBotError(
        `${named.length} agents are named "${reference}": ${named.map((a) => a.id).join(", ")}. Use the agent ID.`,
        0,
      );
    const known = agents.map((a) => `${a.name} (${a.id})`).join(", ") || "none";
    throw new OpenBotError(`No agent "${reference}" with Local scripts on. Agents available: ${known}.`, 404);
  }

  /** An agent's routine by ID or by name. */
  resolveRoutine(agent: Agent, reference: string): Routine {
    const byId = agent.routines.find((r) => r.id === reference);
    if (byId) return byId;
    const wanted = reference.trim().toLocaleLowerCase();
    const named = agent.routines.filter((r) => r.name.trim().toLocaleLowerCase() === wanted);
    if (named.length === 1 && named[0]) return named[0];
    const known = agent.routines.map((r) => `${r.name} (${r.id})`).join(", ") || "none";
    if (named.length > 1) throw new OpenBotError(`${named.length} routines of ${agent.name} are named "${reference}". Use the ID.`, 0);
    throw new OpenBotError(`${agent.name} has no routine "${reference}". Routines: ${known}.`, 404);
  }

  sendMessage(agentId: string, text: string, clientMessageId: string): Promise<MessageReceipt> {
    return this.conn.request("POST", `/v1/agents/${seg(agentId)}/messages`, { text, clientMessageId });
  }

  getDelivery(agentId: string, deliveryId: string): Promise<Delivery> {
    return this.conn.request("GET", `/v1/agents/${seg(agentId)}/deliveries/${seg(deliveryId)}`);
  }

  runRoutine(agentId: string, routineId: string, payload?: string, waitId?: string): Promise<RunReceipt> {
    return this.conn.request("POST", `/v1/agents/${seg(agentId)}/routines/${seg(routineId)}/run`, {
      ...(payload !== undefined ? { payload } : {}),
      ...(waitId !== undefined ? { waitId } : {}),
    });
  }

  updateSettings(agentId: string, change: SettingsChange): Promise<AgentSettings> {
    return this.conn.request("POST", `/v1/agents/${seg(agentId)}/settings`, change);
  }

  clearContext(agentId: string): Promise<{ ok: true }> {
    return this.conn.request("POST", `/v1/agents/${seg(agentId)}/context/clear`);
  }

  getPending(agentId: string): Promise<Pending> {
    return this.conn.request("GET", `/v1/agents/${seg(agentId)}/pending`);
  }

  answerPrompt(agentId: string, requestId: string, answers: Record<string, string[]>): Promise<{ ok: true }> {
    return this.conn.request("POST", `/v1/agents/${seg(agentId)}/prompts/${seg(requestId)}/answer`, { answers });
  }

  respondApproval(agentId: string, requestId: string, decision: "accept" | "decline"): Promise<{ ok: true }> {
    return this.conn.request("POST", `/v1/agents/${seg(agentId)}/approvals/${seg(requestId)}/respond`, { decision });
  }
}

export function pendingCount(p: Pending): number {
  return p.prompts.length + p.approvals.length + p.browserTakeovers.length;
}

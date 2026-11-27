import { randomUUID } from "node:crypto";
import { type McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { type Agent, type OpenBotApi, type Pending, pendingCount } from "./api.js";
import { automationDir, OpenBotError } from "./connection.js";
import { type WaitResult, waitForDelivery } from "./wait.js";

export interface ToolOptions {
  /** Register only the tools that read (no messages, runs, settings, answers). */
  readOnly: boolean;
  /** Register respond_approval (accept/decline commands an agent wants to run). */
  allowApprovals: boolean;
  /** Default wait for wait=true calls. */
  defaultTimeoutSeconds: number;
}

const MAX_TIMEOUT_SECONDS = 3600;

export const agentRef = z.string().min(1).describe("Agent ID or agent name (case-insensitive), as list_agents shows it.");
export const timeoutSeconds = z
  .number()
  .int()
  .min(1)
  .max(MAX_TIMEOUT_SECONDS)
  .optional()
  .describe("How long to wait. Timing out stops only the wait; the agent keeps working.");

export type Extra = {
  signal: AbortSignal;
  _meta?: { progressToken?: string | number };
  sendNotification: (n: { method: "notifications/progress"; params: Record<string, unknown> }) => Promise<void>;
};

export function ok(summary: string, data: unknown): CallToolResult {
  return { content: [{ type: "text", text: `${summary}\n\n${JSON.stringify(data, null, 2)}` }] };
}

function fail(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  const body = error instanceof OpenBotError && error.body && typeof error.body === "object" ? error.body : undefined;
  const text = body ? `${message}\n\n${JSON.stringify(body, null, 2)}` : message;
  return { isError: true, content: [{ type: "text", text }] };
}

/** Wraps a handler so every OpenBot error becomes a tool error the model can read and act on. */
export function guarded<A>(fn: (args: A, extra: Extra) => Promise<CallToolResult>) {
  return async (args: A, extra: unknown): Promise<CallToolResult> => {
    try {
      return await fn(args, extra as Extra);
    } catch (error) {
      return fail(error);
    }
  };
}

function progressReporter(extra: Extra, label: string) {
  const token = extra._meta?.progressToken;
  let count = 0;
  return async (status: string, elapsedMs: number) => {
    if (token === undefined) return;
    count++;
    await extra
      .sendNotification({
        method: "notifications/progress",
        params: { progressToken: token, progress: count, message: `${label}: ${status} (${Math.round(elapsedMs / 1000)}s)` },
      })
      .catch(() => {});
  };
}

function describePending(p: Pending): string {
  const lines: string[] = [];
  for (const prompt of p.prompts) {
    if (prompt.requiresOpenBot) {
      lines.push(`- prompt ${prompt.requestId}: must be answered in OpenBot (secret or redacted question)`);
      continue;
    }
    for (const q of prompt.questions) {
      const opts = q.options ? ` options: ${q.options.map((o) => o.label).join(" | ")}` : " (free text)";
      lines.push(`- prompt ${prompt.requestId} question "${q.id}": ${q.question}${opts}`);
    }
  }
  for (const a of p.approvals)
    lines.push(`- approval ${a.requestId} [${a.kind}]: ${a.command ?? "(no command)"} in ${a.cwd ?? "?"} — ${a.reason ?? ""}`);
  for (const b of p.browserTakeovers) lines.push(`- browser takeover ${b.requestId}: must be done in OpenBot`);
  return lines.join("\n");
}

function describeWait(agent: Agent, deliveryId: string, w: WaitResult): string {
  const d = w.delivery;
  switch (w.state) {
    case "needs-person":
      return (
        `${agent.name} is waiting for a person (delivery ${deliveryId}, ${d?.status}). ` +
        `Answer with answer_prompt / respond_approval, then call wait_for_delivery again.\n${describePending(w.pending!)}`
      );
    case "timed-out":
      return `Stopped waiting; ${agent.name} is still working (${d?.status ?? "unknown"}). Call wait_for_delivery with deliveryId ${deliveryId} to keep waiting.`;
    case "cancelled":
      return `Wait cancelled; ${agent.name} keeps working on delivery ${deliveryId}.`;
    case "ended":
      if (d?.status === "completed") return d.answer ?? `${agent.name} finished with no answer.`;
      return `${agent.name}: ${d?.status}${d?.error ? `: ${d.error}` : ""}${d?.answer ? `\n${d.answer}` : ""}`;
  }
}

export function registerAll(server: McpServer, api: OpenBotApi, opts: ToolOptions): void {
  const waitMs = (s: number | undefined) => (s ?? opts.defaultTimeoutSeconds) * 1000;

  // ───────────────────────────── read tools ─────────────────────────────

  server.registerTool(
    "openbot_status",
    {
      title: "OpenBot connection status",
      description:
        "Check that OpenBot is running and reachable through the Local scripts API, and how many agents allow it. Use first when another tool reports OpenBot unreachable.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded(async () => {
      const dir = automationDir();
      const agents = await api.listAgents();
      return ok(`OpenBot is reachable. ${agents.length} agent(s) have Local scripts on.`, {
        automationDir: dir,
        agents: agents.length,
        readOnly: opts.readOnly,
        approvalsEnabled: opts.allowApprovals && !opts.readOnly,
      });
    }),
  );

  server.registerTool(
    "list_agents",
    {
      title: "List OpenBot agents",
      description:
        "List the OpenBot agents that allow Local scripts, with their routines (id, name, active). Agents without Local scripts on are invisible to this server.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded(async () => {
      const agents = await api.listAgents();
      const lines = agents.map(
        (a) => `- ${a.name} (${a.id})${a.routines.length ? ` routines: ${a.routines.map((r) => `${r.name}${r.active ? "" : " [paused]"}`).join(", ")}` : ""}`,
      );
      return ok(agents.length ? lines.join("\n") : "No agent has Local scripts on.", agents);
    }),
  );

  server.registerTool(
    "get_delivery",
    {
      title: "Get a delivery's status",
      description:
        "Read one message delivery once (no waiting): status queued/starting/running/completed/failed/interrupted/cancelled, and the agent's answer once it ended. Does not count toward the hourly limit.",
      inputSchema: { agent: agentRef, deliveryId: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded(async ({ agent, deliveryId }) => {
      const a = await api.resolveAgent(agent);
      const d = await api.getDelivery(a.id, deliveryId);
      return ok(`${a.name}: ${d.status}${d.answer ? `\n${d.answer}` : ""}`, { agent: { id: a.id, name: a.name }, ...d });
    }),
  );

  server.registerTool(
    "wait_for_delivery",
    {
      title: "Wait for a delivery",
      description:
        "Poll a delivery until the agent finishes, needs a person (question/approval/browser takeover — returned so you can answer), or the timeout passes. Use after send_message/run_routine with wait=false, or to resume a wait.",
      inputSchema: { agent: agentRef, deliveryId: z.string().min(1), timeoutSeconds },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded(async ({ agent, deliveryId, timeoutSeconds }, extra) => {
      const a = await api.resolveAgent(agent);
      const report = progressReporter(extra, a.name);
      const w = await waitForDelivery(api, a.id, deliveryId, {
        timeoutMs: waitMs(timeoutSeconds),
        signal: extra.signal,
        onPoll: (d, ms) => report(d.status, ms),
      });
      return ok(describeWait(a, deliveryId, w), { agent: { id: a.id, name: a.name }, deliveryId, ...w });
    }),
  );

  server.registerTool(
    "get_pending",
    {
      title: "Get requests waiting for a person",
      description:
        "List questions (prompts), approvals and browser takeovers that an agent is blocked on. Omit agent to check every agent. Items with requiresOpenBot must be handled in the OpenBot app.",
      inputSchema: { agent: agentRef.optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded(async ({ agent }) => {
      const agents = agent ? [await api.resolveAgent(agent)] : await api.listAgents();
      const results = await Promise.all(
        agents.map(async (a) => ({ agent: { id: a.id, name: a.name }, pending: await api.getPending(a.id) })),
      );
      const busy = results.filter((r) => pendingCount(r.pending) > 0);
      const summary = busy.length
        ? busy.map((r) => `${r.agent.name} (${r.agent.id}):\n${describePending(r.pending)}`).join("\n\n")
        : "Nothing is waiting for a person.";
      return ok(summary, results);
    }),
  );

  if (opts.readOnly) return;

  // ───────────────────────────── write tools ─────────────────────────────

  server.registerTool(
    "send_message",
    {
      title: "Send a task to an agent",
      description:
        "Send a message to an OpenBot agent through its normal conversation queue. wait=true returns the agent's answer (or what it needs from a person); wait=false returns the deliveryId at once. Counts toward the agent's hourly limit (30 by default). Attachments are not supported.",
      inputSchema: {
        agent: agentRef,
        text: z.string().min(1).describe("The message / task for the agent."),
        wait: z.boolean().optional().describe("Wait for the turn to end. Default false."),
        timeoutSeconds,
        clientMessageId: z
          .string()
          .min(1)
          .max(128)
          .optional()
          .describe("Retry key. Reuse the same key when retrying the same message (deduplicated for 24h); omit for new work."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    guarded(async ({ agent, text, wait, timeoutSeconds, clientMessageId }, extra) => {
      const a = await api.resolveAgent(agent);
      const receipt = await api.sendMessage(a.id, text, clientMessageId ?? `mcp-${randomUUID()}`);
      const delivery = receipt.deliveries.find((d) => d.recipientAgentId === a.id) ?? receipt.deliveries[0];
      if (!delivery) throw new OpenBotError("OpenBot did not queue the message.", 0, receipt);
      const base = { agent: { id: a.id, name: a.name }, messageId: receipt.messageId, deliveryId: delivery.id };
      if (!wait) {
        const pos = delivery.position !== null ? `, position ${delivery.position}` : "";
        return ok(`Queued for ${a.name}: delivery ${delivery.id} (${delivery.status}${pos}).`, { ...base, receipt });
      }
      const report = progressReporter(extra, a.name);
      const w = await waitForDelivery(api, a.id, delivery.id, {
        timeoutMs: waitMs(timeoutSeconds),
        signal: extra.signal,
        onPoll: (d, ms) => report(d.status, ms),
      });
      return ok(describeWait(a, delivery.id, w), { ...base, ...w });
    }),
  );

  server.registerTool(
    "send_to_agents",
    {
      title: "Send a task to several agents",
      description:
        "Send the same message to several agents at once (fan-out) and optionally wait for all of them. Each agent gets its own delivery; failures are reported per agent.",
      inputSchema: {
        agents: z.array(agentRef).min(1).max(50),
        text: z.string().min(1),
        wait: z.boolean().optional(),
        timeoutSeconds,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    guarded(async ({ agents, text, wait, timeoutSeconds }, extra) => {
      const deadline = waitMs(timeoutSeconds);
      const results = await Promise.all(
        agents.map(async (ref) => {
          try {
            const a = await api.resolveAgent(ref);
            const receipt = await api.sendMessage(a.id, text, `mcp-${randomUUID()}`);
            const delivery = receipt.deliveries.find((d) => d.recipientAgentId === a.id) ?? receipt.deliveries[0];
            if (!delivery) throw new OpenBotError("OpenBot did not queue the message.", 0);
            if (!wait) return { agent: ref, ok: true, summary: `queued (${delivery.id})`, deliveryId: delivery.id };
            const w = await waitForDelivery(api, a.id, delivery.id, { timeoutMs: deadline, signal: extra.signal });
            return { agent: ref, ok: true, summary: describeWait(a, delivery.id, w), deliveryId: delivery.id, ...w };
          } catch (error) {
            return { agent: ref, ok: false, summary: error instanceof Error ? error.message : String(error) };
          }
        }),
      );
      const summary = results.map((r) => `### ${r.agent}${r.ok ? "" : " (failed)"}\n${r.summary}`).join("\n\n");
      return ok(summary, results);
    }),
  );

  server.registerTool(
    "run_routine",
    {
      title: "Run an agent's routine",
      description:
        "Start one of an agent's routines now (like Test run, also when paused), optionally with an event payload the agent reads as data. With waitId, wakes only that open wait (openbot.await_event); without it, wakes every matching open wait. No retry key: calling twice runs twice.",
      inputSchema: {
        agent: agentRef,
        routine: z.string().min(1).describe("Routine ID or name, as list_agents shows it."),
        payload: z.string().max(4000).optional().describe("Event text (max 4,000 characters)."),
        waitId: z.string().min(1).optional().describe("Wake only this open wait of the agent."),
        wait: z.boolean().optional().describe("Wait for the run's delivery to end (when it has one)."),
        timeoutSeconds,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    guarded(async ({ agent, routine, payload, waitId, wait, timeoutSeconds }, extra) => {
      const a = await api.resolveAgent(agent);
      const r = api.resolveRoutine(a, routine);
      const receipt = await api.runRoutine(a.id, r.id, payload, waitId);
      const base = { agent: { id: a.id, name: a.name }, routine: r, ...receipt };
      if (!wait || !receipt.deliveryId)
        return ok(
          `Run ${receipt.runId} of "${r.name}" is queued for ${a.name}${receipt.deliveryId ? ` (delivery ${receipt.deliveryId})` : ""}.`,
          base,
        );
      const report = progressReporter(extra, `${a.name}/${r.name}`);
      const w = await waitForDelivery(api, a.id, receipt.deliveryId, {
        timeoutMs: waitMs(timeoutSeconds),
        signal: extra.signal,
        onPoll: (d, ms) => report(d.status, ms),
      });
      return ok(describeWait(a, receipt.deliveryId, w), { ...base, ...w });
    }),
  );

  server.registerTool(
    "update_agent_settings",
    {
      title: "Change an agent's model / provider / account",
      description:
        "Change an agent's provider, model, reasoning effort and/or provider account (same as the model and account controls in OpenBot). model alone picks the provider that lists it; provider alone uses its default model. Provider/account changes wait until the agent is idle (409 while it works). Invalid model/effort gives 409 with the valid values.",
      inputSchema: {
        agent: agentRef,
        provider: z.string().min(1).optional().describe("e.g. claude, codex, grok"),
        model: z.string().min(1).optional().describe("e.g. claude-opus-5-5"),
        reasoningEffort: z.string().min(1).optional().describe("e.g. low, medium, high"),
        providerAccountId: z
          .string()
          .min(1)
          .nullable()
          .optional()
          .describe('Account ID from Settings > Providers, "default" for the provider\'s own sign-in, or null.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guarded(async ({ agent, ...change }) => {
      const body = Object.fromEntries(Object.entries(change).filter(([, v]) => v !== undefined));
      if (Object.keys(body).length === 0) throw new OpenBotError("Give at least one of provider, model, reasoningEffort, providerAccountId.", 400);
      const a = await api.resolveAgent(agent);
      const s = await api.updateSettings(a.id, body);
      return ok(`${s.name}: ${s.provider} ${s.model} (${s.reasoningEffort}), account ${s.providerAccountId ?? "default"}.`, s);
    }),
  );

  server.registerTool(
    "clear_context",
    {
      title: "Start a new chat with an agent",
      description:
        "Same as New chat: the agent forgets the conversation and its next turn starts a fresh provider session. Instructions, model, tools, memories and workspace stay. 409 while the agent works or has queued messages — wait and retry.",
      inputSchema: { agent: agentRef },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    guarded(async ({ agent }) => {
      const a = await api.resolveAgent(agent);
      await api.clearContext(a.id);
      return ok(`${a.name}: new chat started.`, { agent: { id: a.id, name: a.name }, cleared: true });
    }),
  );

  server.registerTool(
    "answer_prompt",
    {
      title: "Answer an agent's question",
      description:
        'Answer a pending question from get_pending. answers maps question id → list of strings, e.g. {"build":["Debug"]}. For options:null questions send typed text; for the "choice" id send each picked label (without the " (…)" note). Expired requests give 409 — call get_pending again.',
      inputSchema: {
        agent: agentRef,
        requestId: z.string().min(1).describe("The prompt's requestId from get_pending, unchanged."),
        answers: z.record(z.string(), z.array(z.string())),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    guarded(async ({ agent, requestId, answers }) => {
      const a = await api.resolveAgent(agent);
      await api.answerPrompt(a.id, requestId, answers);
      return ok(`Answered ${requestId}; ${a.name} resumes.`, { ok: true });
    }),
  );

  if (!opts.allowApprovals) return;

  server.registerTool(
    "respond_approval",
    {
      title: "Accept or decline an agent's approval request",
      description:
        "Accept or decline an approval from get_pending (e.g. a command the agent wants to run). ALWAYS show the person the full kind/command/cwd/reason/permissions and get their explicit decision before accepting. Does not change saved permissions. Owner-only approvals give 403 — the person must answer in OpenBot.",
      inputSchema: {
        agent: agentRef,
        requestId: z.string().min(1),
        decision: z.enum(["accept", "decline"]),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    guarded(async ({ agent, requestId, decision }) => {
      const a = await api.resolveAgent(agent);
      await api.respondApproval(a.id, requestId, decision);
      return ok(`${decision === "accept" ? "Accepted" : "Declined"} ${requestId} for ${a.name}.`, { ok: true, decision });
    }),
  );
}

/** Read-only resources, for clients that browse resources instead of calling tools. */
export function registerResources(server: McpServer, api: OpenBotApi): void {
  server.registerResource(
    "agents",
    "openbot://agents",
    { title: "OpenBot agents", description: "Agents with Local scripts on, and their routines.", mimeType: "application/json" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await api.listAgents(), null, 2) }] }),
  );

  server.registerResource(
    "agent-pending",
    new ResourceTemplate("openbot://agents/{agentId}/pending", {
      list: async () => ({
        resources: (await api.listAgents().catch(() => [])).map((a) => ({
          uri: `openbot://agents/${encodeURIComponent(a.id)}/pending`,
          name: `${a.name} — pending`,
          mimeType: "application/json",
        })),
      }),
    }),
    { title: "Pending requests of an agent", mimeType: "application/json" },
    async (uri, { agentId }) => {
      const id = decodeURIComponent(String(agentId));
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await api.getPending(id), null, 2) }] };
    },
  );
}

/** Prompt templates for common team-management flows. */
export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "delegate",
    {
      title: "Delegate a task to an OpenBot agent",
      description: "Pick the best agent for a task, send it, and handle anything it asks for.",
      argsSchema: { task: z.string().describe("The task to delegate") },
    },
    ({ task }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Delegate this task to my OpenBot team:\n\n${task}\n\n` +
              "1. Call list_agents and choose the agent whose name/routines fit best (ask me if unclear).\n" +
              "2. send_message with wait=true.\n" +
              "3. If it needs a person, show me the questions/approvals in full and wait for my answer before calling answer_prompt or respond_approval, then wait_for_delivery.\n" +
              "4. Report the agent's final answer.",
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "triage_pending",
    {
      title: "Triage everything waiting for me",
      description: "Collect all questions and approvals across agents and walk through them.",
    },
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              "Call get_pending with no agent. Group what is waiting by agent, show each question/approval in full, " +
              "and ask me how to answer each one. Never accept an approval without my explicit yes. " +
              "Tell me which items must be handled in the OpenBot app (requiresOpenBot / browser takeovers).",
          },
        },
      ],
    }),
  );
}

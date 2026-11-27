import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  AGENT_PROVIDERS,
  type AgentSpec,
  AVATAR_HUES,
  composeDescription,
  CREATE_AGENT_GUIDE,
  createAgentArgs,
  LIMITS,
  managerMessage,
  REASONING_EFFORTS,
  RESULT_MARKER,
  reviewSpec,
} from "./agent-design.js";
import type { OpenBotApi } from "./api.js";
import { OpenBotError } from "./connection.js";
import { agentRef, guarded, ok, timeoutSeconds, type ToolOptions } from "./tools.js";
import { waitForDelivery } from "./wait.js";

const specShape = {
  name: z.string().min(1).max(LIMITS.name).describe("Short name of the new agent."),
  title: z.string().max(LIMITS.title).optional().describe('Role title, e.g. "Code reviewer".'),
  job: z.string().min(1).describe("ONE sentence: what it does every time it wakes."),
  antiJobs: z.array(z.string().min(1)).optional().describe("What it never does, even if asked (adjacent work → another agent)."),
  voice: z.string().optional().describe("A few words of tone/character. Not a generic assistant."),
  wake: z.enum(["on-demand", "routine", "both"]).optional(),
  how: z.array(z.string().min(1)).optional().describe("The concrete how: which service, inbox, channel, repo."),
  description: z
    .string()
    .max(LIMITS.description)
    .optional()
    .describe("Full persona text used verbatim instead of composing job/antiJobs/voice/wake/how."),
  initialMessage: z.string().min(1).describe("The new agent's first task."),
  provider: z.enum(AGENT_PROVIDERS).optional().describe("Omit to copy the manager agent's provider/model/account."),
  model: z.string().min(1).max(LIMITS.modelName).optional().describe("Must be listed by openbot.list_models."),
  reasoningEffort: z.enum(REASONING_EFFORTS).optional(),
  avatarHue: z
    .number()
    .int()
    .optional()
    .describe(`One of ${Object.entries(AVATAR_HUES).map(([h, n]) => `${h} ${n}`).join(", ")}.`),
  routine: z
    .object({
      name: z.string().min(1),
      instruction: z.string().min(1),
      schedule: z.string().min(1).describe('Plain language, e.g. "weekdays 09:00".'),
    })
    .optional()
    .describe("A standing routine the manager creates for the new agent (openbot.create_routine)."),
};

export function registerAgentDesign(server: McpServer, api: OpenBotApi, opts: ToolOptions): void {
  server.registerResource(
    "create-agent-guide",
    "openbot://guides/create-agent",
    {
      title: "How to prompt OpenBot to create an agent",
      description: "Fields, limits and the four-part persona structure OpenBot's Agent Designer uses.",
      mimeType: "text/markdown",
    },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: CREATE_AGENT_GUIDE }] }),
  );

  server.registerPrompt(
    "design_agent",
    {
      title: "Design a new OpenBot agent",
      description: "Interview the user briefly, draft a tight persona, preview it with create_agent dryRun, then create it.",
      argsSchema: { idea: z.string().describe("What the new agent is for, in the user's words") },
    },
    ({ idea }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `I want a new OpenBot agent: ${idea}\n\n` +
              "Follow this guide:\n\n" +
              CREATE_AGENT_GUIDE +
              "\n\nSteps:\n" +
              "1. Ask me only the intake questions I have not answered (one job, name/voice, routine or on-demand, who it talks to). Pick reversible details yourself and say what you picked.\n" +
              "2. Call list_agents and pick a manager agent to do the creation (ask me if there are several plausible ones).\n" +
              "3. Call create_agent with dryRun=true, show me the composed description, the warnings, and the exact message, and fix any errors.\n" +
              "4. After my OK, call create_agent with dryRun=false.\n" +
              "5. Remind me to turn on Local scripts for the new agent if I want to control it from here.",
          },
        },
      ],
    }),
  );

  server.registerTool(
    "create_agent",
    {
      title: "Create a new OpenBot agent (via a manager agent)",
      description:
        "Compose and validate a new agent's profile the way OpenBot's Agent Designer does (one job → anti-jobs → voice → wake, description ≤ 2,000 chars), " +
        "then ask an existing 'manager' agent to call openbot.create_agent with exactly those arguments. " +
        "dryRun=true (default) only returns the description, the create_agent arguments, warnings and the message — nothing is sent. " +
        "The Local scripts API cannot create agents itself; the new agent starts with Local scripts OFF. Read openbot://guides/create-agent for the rules.",
      inputSchema: {
        ...specShape,
        manager: agentRef.optional().describe("Existing agent that performs the creation. Required when dryRun=false."),
        dryRun: z.boolean().optional().describe("Default true: preview only."),
        timeoutSeconds,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    guarded(async ({ manager, dryRun, timeoutSeconds, ...input }, extra) => {
      const spec = input as AgentSpec;
      const description = composeDescription(spec);
      const review = reviewSpec(spec, description);
      const message = managerMessage(spec, description);
      const preview = {
        description,
        descriptionLength: `${description.length}/${LIMITS.description}`,
        createAgentArgs: createAgentArgs(spec, description),
        errors: review.errors,
        warnings: review.warnings,
        message,
      };
      const isDry = dryRun ?? true;
      if (isDry || review.errors.length) {
        const head = review.errors.length
          ? `Not ready — fix ${review.errors.length} error(s): ${review.errors.join("; ")}`
          : `Preview only (dryRun). ${review.warnings.length ? `Warnings: ${review.warnings.join("; ")}` : "No warnings."} Call again with dryRun=false and a manager to create it.`;
        return { ...ok(`${head}\n\n--- description ---\n${description}`, preview), isError: review.errors.length > 0 && !isDry };
      }
      if (opts.readOnly) throw new OpenBotError("This server is read-only (OPENBOT_MCP_READONLY).", 403);
      if (!manager) throw new OpenBotError("manager is required to create the agent: an existing agent with Local scripts on.", 400);

      const m = await api.resolveAgent(manager);
      const receipt = await api.sendMessage(m.id, message, `mcp-create-${randomUUID()}`);
      const delivery = receipt.deliveries.find((d) => d.recipientAgentId === m.id) ?? receipt.deliveries[0];
      if (!delivery) throw new OpenBotError("OpenBot did not queue the message.", 0, receipt);
      const w = await waitForDelivery(api, m.id, delivery.id, {
        timeoutMs: (timeoutSeconds ?? opts.defaultTimeoutSeconds) * 1000,
        signal: extra.signal,
      });
      const answer = w.delivery?.answer ?? "";
      const newId = new RegExp(`${RESULT_MARKER}\\s*\`?([\\w:.-]+)`, "u").exec(answer)?.[1];
      const base = { manager: { id: m.id, name: m.name }, deliveryId: delivery.id, newAgentId: newId ?? null, ...w, preview };

      if (w.state === "needs-person")
        return ok(
          `${m.name} needs a person before it can create "${spec.name}" (OpenBot may ask the owner to approve). ` +
            `Show the request with get_pending, then answer_prompt / respond_approval, then wait_for_delivery ${delivery.id}.`,
          base,
        );
      if (w.state !== "ended")
        return ok(`${m.name} is still working on it (delivery ${delivery.id}). Use wait_for_delivery to keep waiting.`, base);
      if (!newId)
        return { ...ok(`${m.name} answered without a new agent id — it probably did not create it:\n\n${answer}`, base), isError: true };
      return ok(
        `Created "${spec.name}" (${newId}) via ${m.name}.\n\n${answer}\n\n` +
          "Next: in OpenBot open the new agent → Settings → Permissions → turn on Local scripts, so this MCP can see and control it.",
        base,
      );
    }),
  );
}

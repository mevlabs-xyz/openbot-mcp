// How OpenBot creates agents, distilled from nightly-labs/openbot:
// - src/backend/agent/profile-tools.ts        (openbot.create_agent schema)
// - src/backend/agent/tool-guidance.ts        (what OpenBot tells its agents about create_agent)
// - marketplace/production-catalog/skills/agent-designer/SKILL.md (the built-in "Agent Designer" skill)
// - packages/contracts/src/input-limits.ts, agent-providers.ts, ipc-agent-identity.ts (limits & enums)
//
// The Local scripts API has no "create agent" route, so creation is delegated: an existing
// ("manager") agent receives a precise message and calls its own openbot.create_agent tool.

export const LIMITS = { name: 80, title: 120, description: 2000, initialMessage: 100_000, modelName: 160 } as const;

export const AGENT_PROVIDERS = [
  "codex", "claude", "grok", "opencode", "antigravity", "cursor", "cline", "pi", "muse",
  "inception", "deepseek", "openrouter", "hermes", "acp", "kimi", "devin", "copilot", "mistral",
] as const;

export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

export const AVATAR_HUES = {
  0: "red", 30: "orange", 55: "yellow", 100: "lime", 150: "green",
  185: "cyan", 215: "blue", 245: "indigo", 280: "violet", 320: "magenta",
} as const;

export type Wake = "on-demand" | "routine" | "both";

export interface RoutineSpec {
  name: string;
  instruction: string;
  /** Plain-language schedule, e.g. "weekdays 09:00". The manager agent maps it to create_routine. */
  schedule: string;
}

export interface AgentSpec {
  name: string;
  title?: string;
  /** One sentence: what it does every time it wakes. */
  job: string;
  /** What it never does, even if asked. */
  antiJobs?: string[];
  /** A few words: tone / character. */
  voice?: string;
  wake?: Wake;
  /** The concrete how: which service, inbox, channel, repo. */
  how?: string[];
  /** Used verbatim instead of composing job/antiJobs/voice/wake/how. */
  description?: string;
  initialMessage: string;
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  avatarHue?: number;
  routine?: RoutineSpec;
}

/**
 * The persona text that becomes the agent's `description` (its whole instructions, ≤ 2,000 chars).
 * Order follows the Agent Designer skill: one job → anti-jobs → voice → wake, then the concrete how.
 */
export function composeDescription(spec: AgentSpec): string {
  if (spec.description) return spec.description.trim();
  const parts: string[] = [spec.job.trim()];
  if (spec.antiJobs?.length) parts.push(`Never: ${spec.antiJobs.map((s) => s.trim().replace(/\.$/u, "")).join("; ")}. Hand adjacent work to another agent.`);
  if (spec.how?.length) parts.push(`How: ${spec.how.map((s) => s.trim().replace(/\.$/u, "")).join("; ")}.`);
  if (spec.voice) parts.push(`Voice: ${spec.voice.trim()}. Short replies, no filler.`);
  const wake =
    spec.wake === "routine"
      ? "You run on a routine. When there is nothing to report, stay quiet."
      : spec.wake === "both"
        ? "You answer on demand and run on a routine. On a routine run with nothing to report, stay quiet."
        : spec.wake === "on-demand"
          ? "You work when asked."
          : undefined;
  if (wake) parts.push(wake);
  return parts.join("\n\n");
}

export interface Review {
  errors: string[];
  warnings: string[];
}

/** Checks the hard limits OpenBot enforces and the soft rules of the Agent Designer skill. */
export function reviewSpec(spec: AgentSpec, description: string): Review {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!spec.name.trim()) errors.push("name is empty");
  if (spec.name.length > LIMITS.name) errors.push(`name is ${spec.name.length} chars (max ${LIMITS.name})`);
  if ((spec.title ?? "").length > LIMITS.title) errors.push(`title is over ${LIMITS.title} chars`);
  if (description.length > LIMITS.description)
    errors.push(`description is ${description.length} chars (max ${LIMITS.description}) — cut it; it is the whole persona`);
  if (!spec.initialMessage.trim()) errors.push("initialMessage (the first task) is required");
  if (spec.provider && !(AGENT_PROVIDERS as readonly string[]).includes(spec.provider))
    errors.push(`provider "${spec.provider}" is not one of: ${AGENT_PROVIDERS.join(", ")}`);
  if (spec.reasoningEffort && !(REASONING_EFFORTS as readonly string[]).includes(spec.reasoningEffort))
    errors.push(`reasoningEffort "${spec.reasoningEffort}" is not one of: ${REASONING_EFFORTS.join(", ")}`);
  if (spec.avatarHue !== undefined && !(String(spec.avatarHue) in AVATAR_HUES))
    errors.push(`avatarHue must be one of ${Object.entries(AVATAR_HUES).map(([h, n]) => `${h} ${n}`).join(", ")}`);
  if (spec.model && spec.model.length > LIMITS.modelName) errors.push("model id is too long");

  if (!spec.description) {
    const sentences = spec.job.trim().split(/(?<=[.!?])\s+/u);
    if (sentences.length > 1) warnings.push("job should be ONE sentence — split extra duties into anti-jobs or another agent");
    if (!spec.antiJobs?.length) warnings.push("no anti-jobs: say what it never does (e.g. a drafter never sends, a scout never posts)");
    if (!spec.voice) warnings.push("no voice: give a few words (match the user or a named character), not a generic assistant");
  }
  if (/I can also help|whatever tools you have|as an AI/iu.test(description))
    warnings.push('remove filler such as "I can also help with…" / "use whatever tools you have" — name the concrete service/inbox/channel instead');
  if ((spec.wake === "routine" || spec.wake === "both") && !spec.routine)
    warnings.push("wake is routine but no routine given — the manager should create it with openbot.create_routine, or add it in the app");
  if (spec.model && !spec.provider) warnings.push("model without provider: the manager must check it with openbot.list_models");
  return { errors, warnings };
}

/** The create_agent arguments exactly as openbot.create_agent takes them. */
export function createAgentArgs(spec: AgentSpec, description: string): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries({
      name: spec.name.trim(),
      title: spec.title?.trim() || undefined,
      description,
      initialMessage: spec.initialMessage.trim(),
      provider: spec.provider,
      model: spec.model,
      reasoningEffort: spec.reasoningEffort,
      avatarHue: spec.avatarHue,
    }).filter(([, v]) => v !== undefined),
  );
}

export const RESULT_MARKER = "CREATED_AGENT_ID:";

/** The message sent to the manager agent. Written as tool-level steps so the agent does not improvise. */
export function managerMessage(spec: AgentSpec, description: string): string {
  const args = createAgentArgs(spec, description);
  const steps = [
    spec.provider || spec.model || spec.reasoningEffort
      ? "1. Call openbot.list_models. If the provider/model/reasoningEffort below is not listed, stop and reply with the valid choices instead of creating anything."
      : "1. (No model given: the new agent uses your provider, model and account. Do not call list_models.)",
    "2. Call openbot.create_agent ONCE with exactly these arguments. Do not rewrite the description:",
    "```json",
    JSON.stringify(args, null, 2),
    "```",
    "3. Call openbot.read_agent with the new agent's id and check that name and description match.",
    spec.routine
      ? `4. Call openbot.create_routine with the new agent's id: name "${spec.routine.name}", schedule "${spec.routine.schedule}" (use the coarsest matching schedule), instruction:\n"${spec.routine.instruction.trim()} When there is nothing to report, stay quiet."\nThen confirm it with openbot.list_routines.`
      : "4. Do not create a routine.",
    `5. Reply with one line \`${RESULT_MARKER} <id>\`, then the name and its one-job line. If any step failed, say which and why.`,
  ];
  return `Create a new persistent OpenBot teammate for me. This is a direct request from the user, through a local script.\n\n${steps.join("\n")}`;
}

/** Long-form guide, served as a resource and inside the design prompt. */
export const CREATE_AGENT_GUIDE = `# Writing a prompt that creates an OpenBot agent

OpenBot agents are created by an existing agent calling its built-in tool \`openbot.create_agent\`
(the Local scripts API has no create route). A good request is a precise call, not a wish.

## create_agent fields
| field | rule |
| --- | --- |
| name | required, ≤ ${LIMITS.name} chars, short |
| title | optional, ≤ ${LIMITS.title} chars (e.g. "Code reviewer") |
| description | the WHOLE persona / instructions, ≤ ${LIMITS.description} chars |
| initialMessage | required — the agent's first task |
| provider | optional: ${AGENT_PROVIDERS.join(", ")} |
| model | optional, must be listed by openbot.list_models |
| reasoningEffort | optional: ${REASONING_EFFORTS.join(", ")} |
| avatarHue | optional: ${Object.entries(AVATAR_HUES).map(([h, n]) => `${h} ${n}`).join(", ")}, or null |
Omit provider/model/effort and the new agent copies the creator's.

## The description: four parts, in this order (OpenBot's Agent Designer skill)
1. **One job** — one sentence: what it does every time it wakes. Name it first.
2. **Anti-jobs** — what it never does, even if asked (a drafter never sends; a scout never posts). Adjacent work goes to another agent.
3. **Voice** — a few words. Match the user or a named character. Not "a helpful assistant".
4. **Wake** — on-demand, a standing routine, or both. Quiet when there is nothing to report.
Then the concrete **how**: which service, inbox, channel, repo — never "use whatever tools you have".
No padding: no tool lists, model essays, or "I can also help with…".

## Things the description cannot do (set them elsewhere)
- Schedules: the creator calls \`openbot.create_routine\` with the new agent's id — do not ask the new agent to schedule itself.
- Access / Computer Use: only the user can widen them, in the app. update_profile can only narrow them.
- Marketplace skills (e.g. pstack): the user adds them in the new agent's Skills settings.
- **Local scripts is OFF on the new agent.** Turn it on in the app (Settings → Permissions) before this MCP can see it.

## Template
> Create a new teammate with openbot.create_agent:
> - name: Scout
> - title: Mentions scout
> - description: "You find new mentions of <product> on <sites> and list them with links. Never: reply, post, or like anything; hand that to another agent. Voice: terse, factual. You run on a routine; when nothing is new, stay quiet."
> - initialMessage: "Introduce yourself in one line and list today's mentions."
> - (optional) provider/model from openbot.list_models
> Then read_agent to verify, and create_routine "Morning scan" weekdays 09:00 for it.

## Before creating, ask the user only what no experiment can settle
the one job · name/voice (if they care) · routine or on-demand · who it talks to.
Copy model/tools from a working sibling agent instead of asking.
`;

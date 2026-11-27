// A stand-in for OpenBot's Local scripts listener, following docs/automation.md.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

interface MockDelivery {
  id: string;
  agentId: string;
  status: string;
  turnId: string | null;
  error: string | null;
  answer: string | null;
  polls: number;
  blockedOn?: string; // requestId of a pending prompt/approval
  text: string;
}

export interface MockOpenBot {
  url: string;
  close(): Promise<void>;
  /** Simulate an OpenBot restart: new token written to the automation folder. */
  rotateToken(): Promise<void>;
  state: { settings: Record<string, Record<string, unknown>>; cleared: string[]; runs: unknown[] };
}

export async function startMock(dir: string): Promise<MockOpenBot> {
  let token = randomBytes(16).toString("hex");
  const agents = [
    { id: "agent-ada", name: "Ada", routines: [{ id: "routine-wake", name: "Wake", active: false }] },
    { id: "agent-bob", name: "Bob", routines: [] as { id: string; name: string; active: boolean }[] },
  ];
  const deliveries = new Map<string, MockDelivery>();
  const prompts = new Map<string, { agentId: string; deliveryId: string }>();
  const approvals = new Map<string, { agentId: string; deliveryId: string }>();
  const state: MockOpenBot["state"] = {
    settings: Object.fromEntries(agents.map((a) => [a.id, { provider: "claude", model: "claude-sonnet-5-5", reasoningEffort: "medium", providerAccountId: null }])),
    cleared: [],
    runs: [],
  };

  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const readBody = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let s = "";
      req.on("data", (c) => (s += c));
      req.on("end", () => resolve(s));
    });

  const server = createServer(async (req, res) => {
    const host = req.headers.host ?? "";
    if (req.headers.origin || !host.startsWith("127.0.0.1:")) return send(res, 403, { error: "Forbidden" });
    if (req.headers.authorization !== `Bearer ${token}`) return send(res, 401, { error: "Wrong token" });
    const url = new URL(req.url ?? "/", "http://x");
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent); // v1 agents :id ...
    const raw = await readBody(req);
    let body: any = null;
    if (req.method === "POST" && raw) {
      if (req.headers["content-type"] !== "application/json") return send(res, 415, { error: "Use application/json" });
      try {
        body = JSON.parse(raw);
      } catch {
        return send(res, 400, { error: "Not JSON" });
      }
    }

    if (req.method === "GET" && url.pathname === "/v1/agents") return send(res, 200, agents);
    const agent = agents.find((a) => a.id === parts[2]);
    if (parts[0] !== "v1" || parts[1] !== "agents" || !agent) return send(res, 404, { error: "No such agent" });
    const route = parts.slice(3);

    // POST /messages
    if (req.method === "POST" && route[0] === "messages") {
      if (typeof body?.text !== "string") return send(res, 400, { error: "text" });
      const d: MockDelivery = { id: `delivery-${randomUUID()}`, agentId: agent.id, status: "queued", turnId: null, error: null, answer: null, polls: 0, text: body.text };
      deliveries.set(d.id, d);
      return send(res, 202, { messageId: `message-${randomUUID()}`, deliveries: [{ id: d.id, recipientAgentId: agent.id, status: "queued", position: 0 }] });
    }
    // GET /deliveries/:id — advance a little each poll
    if (req.method === "GET" && route[0] === "deliveries") {
      const d = deliveries.get(route[1] ?? "");
      if (!d || d.agentId !== agent.id) return send(res, 404, { error: "No such delivery" });
      d.polls++;
      if (d.status === "queued") {
        d.status = "running";
        d.turnId = `turn-${randomUUID()}`;
        if (d.text.includes("ASK")) {
          const id = `req-${randomUUID()}`;
          prompts.set(id, { agentId: agent.id, deliveryId: d.id });
          d.blockedOn = id;
        } else if (d.text.includes("APPROVE")) {
          const id = `req-${randomUUID()}`;
          approvals.set(id, { agentId: agent.id, deliveryId: d.id });
          d.blockedOn = id;
        }
      } else if (d.status === "running" && !d.blockedOn && !d.text.includes("SLOW") && d.polls >= 2) {
        d.status = "completed";
        d.answer = d.answer ?? (d.text.includes("openbot.create_agent") ? "CREATED_AGENT_ID: agent-new\nScout: finds mentions." : `${agent.name} did: ${d.text}`);
      }
      const { polls, blockedOn, text, agentId, ...pub } = d;
      return send(res, 200, pub);
    }
    if (req.method === "GET" && route[0] === "pending") {
      const mine = [...prompts].filter(([, p]) => p.agentId === agent.id);
      const mineA = [...approvals].filter(([, p]) => p.agentId === agent.id);
      return send(res, 200, {
        prompts: mine.map(([requestId]) => ({
          requestId,
          requiresOpenBot: false,
          questions: [{ id: "build", header: "Build", question: "Which build?", options: [{ label: "Debug", description: "Use debug settings" }, { label: "Release" }] }],
        })),
        approvals: mineA.map(([requestId, p]) => ({
          requestId, agentId: agent.id, threadId: "thread-1", turnId: deliveries.get(p.deliveryId)?.turnId, kind: "command",
          command: "rm -rf build", cwd: "/work", reason: "clean build", grantRoot: null, permissions: null,
        })),
        browserTakeovers: [],
      });
    }
    if (req.method === "POST" && route[0] === "prompts" && route[2] === "answer") {
      const p = prompts.get(route[1] ?? "");
      if (!p || p.agentId !== agent.id) return send(res, 409, { error: "Request expired" });
      prompts.delete(route[1]!);
      const d = deliveries.get(p.deliveryId)!;
      d.blockedOn = undefined;
      d.answer = `Built ${JSON.stringify(body?.answers)}`;
      return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && route[0] === "approvals" && route[2] === "respond") {
      const p = approvals.get(route[1] ?? "");
      if (!p || p.agentId !== agent.id) return send(res, 409, { error: "Request expired" });
      if (body?.decision !== "accept" && body?.decision !== "decline") return send(res, 400, { error: "decision" });
      approvals.delete(route[1]!);
      const d = deliveries.get(p.deliveryId)!;
      d.blockedOn = undefined;
      d.answer = `approval ${body.decision}ed`;
      return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && route[0] === "routines" && route[2] === "run") {
      const r = agent.routines.find((x) => x.id === route[1]);
      if (!r) return send(res, 404, { error: "No such routine" });
      if (body?.payload !== undefined && typeof body.payload !== "string") return send(res, 400, { error: "payload" });
      if ((body?.payload ?? "").length > 4000) return send(res, 413, { error: "payload too long" });
      state.runs.push({ agentId: agent.id, routineId: r.id, ...body });
      const d: MockDelivery = { id: `delivery-${randomUUID()}`, agentId: agent.id, status: "queued", turnId: null, error: null, answer: null, polls: 0, text: `routine ${r.name}: ${body?.payload ?? ""}` };
      deliveries.set(d.id, d);
      return send(res, 202, { runId: `run-${randomUUID()}`, deliveryId: d.id });
    }
    if (req.method === "POST" && route[0] === "settings") {
      const allowed = ["provider", "model", "reasoningEffort", "providerAccountId"];
      if (Object.keys(body ?? {}).some((k) => !allowed.includes(k))) return send(res, 400, { error: "Change that in OpenBot" });
      if (body.model === "bogus") return send(res, 409, { error: "Unknown model", models: ["claude-opus-5-5", "claude-sonnet-5-5"] });
      Object.assign(state.settings[agent.id]!, body);
      return send(res, 200, { id: agent.id, name: agent.name, ...state.settings[agent.id] });
    }
    if (req.method === "POST" && route[0] === "context" && route[1] === "clear") {
      const busy = [...deliveries.values()].some((d) => d.agentId === agent.id && (d.status === "running" || d.status === "queued"));
      if (busy) return send(res, 409, { error: "The agent is working" });
      state.cleared.push(agent.id);
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: "No such route" });
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await mkdir(dir, { recursive: true });
  const writeFiles = async () => {
    await writeFile(join(dir, "url"), `${url}\n`);
    await writeFile(join(dir, "token"), `${token}\n`);
    await writeFile(join(dir, "headers"), `Authorization: Bearer ${token}\n`);
  };
  await writeFiles();

  return {
    url,
    state,
    close: () => new Promise((r) => server.close(() => r())),
    rotateToken: async () => {
      token = randomBytes(16).toString("hex");
      await writeFiles();
    },
  };
}

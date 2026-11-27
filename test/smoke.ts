// End-to-end: real MCP server (dist/index.js) over stdio ↔ mock OpenBot.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startMock } from "./mock-openbot.js";

const dir = await mkdtemp(join(tmpdir(), "openbot-mcp-test-"));
const mock = await startMock(dir);

async function connect(env: Record<string, string> = {}) {
  const client = new Client({ name: "smoke", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["dist/index.js"],
      env: { ...(process.env as Record<string, string>), OPENBOT_AUTOMATION_DIR: dir, ...env },
    }),
  );
  return client;
}

const text = (r: any) => r.content.map((c: any) => c.text).join("\n") as string;
let passed = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}\n`, error);
    process.exitCode = 1;
  }
}

const client = await connect();
const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });

await check("lists all tools, resources and prompts", async () => {
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, [
    "answer_prompt", "clear_context", "create_agent", "get_delivery", "get_pending", "list_agents", "openbot_status",
    "respond_approval", "run_routine", "send_message", "send_to_agents", "update_agent_settings", "wait_for_delivery",
  ]);
  const res = await client.listResources();
  assert.ok(res.resources.some((r) => r.uri === "openbot://agents"));
  assert.ok(res.resources.some((r) => r.uri === "openbot://agents/agent-ada/pending"));
  const prompts = (await client.listPrompts()).prompts.map((p) => p.name).sort();
  assert.deepEqual(prompts, ["delegate", "design_agent", "triage_pending"]);
  assert.ok(res.resources.some((r) => r.uri === "openbot://guides/create-agent"));
});

await check("openbot_status + list_agents", async () => {
  assert.match(text(await call("openbot_status")), /2 agent/);
  assert.match(text(await call("list_agents")), /Ada \(agent-ada\) routines: Wake \[paused\]/);
});

await check("send_message wait=true returns the answer (agent by name, any case)", async () => {
  const r = await call("send_message", { agent: "bob", text: "run tests", wait: true, timeoutSeconds: 30 });
  assert.ok(!r.isError, text(r));
  assert.match(text(r), /Bob did: run tests/);
});

await check("send_message wait=false then wait_for_delivery / get_delivery", async () => {
  const r = await call("send_message", { agent: "agent-ada", text: "lint" });
  const id = /delivery (delivery-[\w-]+)/.exec(text(r))?.[1];
  assert.ok(id, text(r));
  const w = await call("wait_for_delivery", { agent: "Ada", deliveryId: id, timeoutSeconds: 30 });
  assert.match(text(w), /Ada did: lint/);
  assert.match(text(await call("get_delivery", { agent: "Ada", deliveryId: id })), /completed/);
});

await check("question flow: needs-person → get_pending → answer_prompt → finished", async () => {
  const r = await call("send_message", { agent: "Ada", text: "ASK which build", wait: true, timeoutSeconds: 30 });
  assert.match(text(r), /waiting for a person/);
  const deliveryId = /delivery (delivery-[\w-]+)/.exec(text(r))?.[1]!;
  const p = await call("get_pending", {});
  const requestId = /prompt (req-[\w-]+) question "build"/.exec(text(p))?.[1];
  assert.ok(requestId, text(p));
  assert.ok(!(await call("answer_prompt", { agent: "Ada", requestId, answers: { build: ["Debug"] } })).isError);
  const w = await call("wait_for_delivery", { agent: "Ada", deliveryId, timeoutSeconds: 30 });
  assert.match(text(w), /Built \{"build":\["Debug"\]\}/);
  // expired request → 409 surfaced as tool error
  const again = await call("answer_prompt", { agent: "Ada", requestId, answers: { build: ["Debug"] } });
  assert.ok(again.isError);
  assert.match(text(again), /409/);
});

await check("approval flow: details shown, decline works", async () => {
  const r = await call("send_message", { agent: "Bob", text: "APPROVE cleanup", wait: true, timeoutSeconds: 30 });
  assert.match(text(r), /approval (req-[\w-]+) \[command\]: rm -rf build in \/work/);
  const requestId = /approval (req-[\w-]+)/.exec(text(r))?.[1];
  assert.ok(!(await call("respond_approval", { agent: "Bob", requestId, decision: "decline" })).isError);
});

await check("run_routine by name with payload, wait=true", async () => {
  const r = await call("run_routine", { agent: "Ada", routine: "wake", payload: "build ended 0", wait: true, timeoutSeconds: 30 });
  assert.ok(!r.isError, text(r));
  assert.match(text(r), /routine Wake: build ended 0/);
  assert.deepEqual((mock.state.runs.at(-1) as any).payload, "build ended 0");
  const missing = await call("run_routine", { agent: "Ada", routine: "nope" });
  assert.ok(missing.isError);
  assert.match(text(missing), /Routines: Wake \(routine-wake\)/);
});

await check("update_agent_settings, incl. 409 with valid values", async () => {
  const r = await call("update_agent_settings", { agent: "Ada", model: "claude-opus-5-5", reasoningEffort: "high" });
  assert.match(text(r), /claude claude-opus-5-5 \(high\)/);
  const bad = await call("update_agent_settings", { agent: "Ada", model: "bogus" });
  assert.ok(bad.isError);
  assert.match(text(bad), /claude-sonnet-5-5/);
  assert.ok((await call("update_agent_settings", { agent: "Ada" })).isError);
});

await check("clear_context ok when idle, 409 while busy", async () => {
  assert.ok(!(await call("clear_context", { agent: "Ada" })).isError);
  await call("send_message", { agent: "Bob", text: "SLOW job" });
  const busy = await call("clear_context", { agent: "Bob" });
  assert.ok(busy.isError);
  assert.match(text(busy), /409/);
});

await check("wait timeout only stops the wait", async () => {
  const r = await call("send_message", { agent: "Bob", text: "SLOW again", wait: true, timeoutSeconds: 3 });
  assert.match(text(r), /Stopped waiting; Bob is still working/);
});

await check("send_to_agents fans out and reports per-agent failure", async () => {
  const r = await call("send_to_agents", { agents: ["Ada", "Nobody"], text: "status", wait: true, timeoutSeconds: 30 });
  assert.match(text(r), /### Ada\nAda did: status/);
  assert.match(text(r), /### Nobody \(failed\)\nNo agent "Nobody"/);
});

await check("create_agent dryRun composes the 4-part persona and warns", async () => {
  const r = await call("create_agent", { name: "Scout", job: "You find new mentions of Acme on X and Reddit. You also reply to them.", initialMessage: "List today's mentions.", wake: "routine" });
  assert.ok(!r.isError, text(r));
  assert.match(text(r), /Preview only/);
  assert.match(text(r), /ONE sentence/);
  assert.match(text(r), /no anti-jobs/);
  assert.match(text(r), /stay quiet/);
  assert.equal(mock.state.runs.length, 1); // nothing sent
});

await check("create_agent rejects limits/enums", async () => {
  const r = await call("create_agent", { name: "X", job: "Job.", initialMessage: "go", avatarHue: 42, description: "d".repeat(2000) + "!" });
  assert.ok(r.isError);
  const r2 = await call("create_agent", { name: "X", job: "Job.", initialMessage: "go", avatarHue: 42, dryRun: false, manager: "Ada" });
  assert.ok(r2.isError);
  assert.match(text(r2), /avatarHue must be one of/);
});

await check("create_agent via manager returns new id and Local scripts reminder", async () => {
  const r = await call("create_agent", {
    name: "Scout", title: "Mentions scout", job: "You find new mentions of Acme on Reddit and list them with links.",
    antiJobs: ["reply, post or like anything"], voice: "terse, factual", wake: "routine",
    routine: { name: "Morning scan", instruction: "List new mentions since yesterday.", schedule: "weekdays 09:00" },
    initialMessage: "Introduce yourself in one line.", provider: "claude", model: "claude-opus-5-5",
    manager: "Ada", dryRun: false, timeoutSeconds: 30,
  });
  assert.ok(!r.isError, text(r));
  assert.match(text(r), /Created "Scout" \(agent-new\) via Ada/);
  assert.match(text(r), /turn on Local scripts/);
  assert.match(text(r), /openbot.list_models/);
  assert.match(text(r), /create_routine/);
});

await check("survives an OpenBot restart (new token)", async () => {
  await mock.rotateToken();
  assert.match(text(await call("list_agents")), /Ada/);
});

await check("resource reads", async () => {
  const r = await client.readResource({ uri: "openbot://agents" });
  assert.match((r.contents[0] as any).text, /agent-bob/);
});

await client.close();

await check("read-only mode registers only read tools", async () => {
  const ro = await connect({ OPENBOT_MCP_READONLY: "1" });
  const tools = (await ro.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, ["create_agent", "get_delivery", "get_pending", "list_agents", "openbot_status", "wait_for_delivery"]);
  await ro.close();
});

await check("approvals can be disabled", async () => {
  const c = await connect({ OPENBOT_MCP_DISABLE_APPROVALS: "1" });
  assert.ok(!(await c.listTools()).tools.some((t) => t.name === "respond_approval"));
  await c.close();
});

await check("clear error when OpenBot is not running", async () => {
  const c = await connect({ OPENBOT_AUTOMATION_DIR: join(dir, "missing") });
  const r = await c.callTool({ name: "list_agents", arguments: {} });
  assert.ok(r.isError);
  assert.match(text(r), /OpenBot is not running/);
  await c.close();
});

await mock.close();
await rm(dir, { recursive: true, force: true });
console.log(`\n${passed} checks passed${process.exitCode ? ", some FAILED" : ""}.`);

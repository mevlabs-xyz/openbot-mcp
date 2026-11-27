#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAgentDesign } from "./agent-design-tools.js";
import { OpenBotApi } from "./api.js";
import { OpenBotConnection } from "./connection.js";
import { registerAll, registerPrompts, registerResources } from "./tools.js";

const flag = (name: string) => /^(1|true|yes|on)$/iu.test(process.env[name] ?? "");

const api = new OpenBotApi(new OpenBotConnection());
const server = new McpServer(
  { name: "openbot-mcp", version: "0.1.0" },
  {
    instructions:
      "Controls the user's OpenBot agents through OpenBot's Local scripts API. Only agents with Local scripts on are visible. " +
      "Use list_agents first. send_message(wait=true) delegates a task and returns the answer, or the questions/approvals the agent waits on. " +
      "Never accept an approval without showing the person the full request and getting an explicit yes.",
  },
);

const options = {
  readOnly: flag("OPENBOT_MCP_READONLY"),
  allowApprovals: !flag("OPENBOT_MCP_DISABLE_APPROVALS"),
  defaultTimeoutSeconds: Number(process.env.OPENBOT_MCP_WAIT_SECONDS) || 300,
};
registerAll(server, api, options);
registerAgentDesign(server, api, options);
registerResources(server, api);
registerPrompts(server);

await server.connect(new StdioServerTransport());

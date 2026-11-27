# openbot-mcp

An MCP server for directing and managing [OpenBot](https://github.com/nightly-labs/openbot) agents
from any MCP client (Claude Code, Claude Desktop, Cursor, …) through OpenBot's **Local scripts API**
(`docs/automation.md`). It covers every route the API offers.

## Prepare OpenBot

1. Open the OpenBot app.
2. For each agent you want to control: **Settings → Permissions → Local scripts = On**
   (agents without it are invisible to this server).
3. OpenBot writes `url` / `token` files to `%APPDATA%\OpenBot\automation\`
   (macOS `~/Library/Application Support/OpenBot/automation`, Linux `~/.config/OpenBot/automation`).
   The server re-reads them when OpenBot restarts, so there is no token to configure.

## Create your first agent (Manager)

The MCP server needs at least one agent with Local scripts on, because:

1. OpenBot starts its listener and writes the `url` / `token` files **only while at least one agent
   has Local scripts on**. With none, the MCP server has nothing to connect to.
2. The Local scripts API **has no route to create agents**. This server's `create_agent` instead
   asks an existing agent to call OpenBot's built-in `openbot.create_agent` tool.
3. A script cannot turn on Local scripts or widen permissions (an OpenBot security boundary), so you
   have to click it in the app at least once.

Make the first agent a **Manager**: its one job is creating agents and routing work. It never does
the work itself. Turn on Local scripts for this agent only, so there is a single entry point from outside.

### Profile

| Field | Value |
| --- | --- |
| name | `Manager` |
| title | `Team dispatcher` |
| provider / model | `claude` / `claude-opus-5-5` (or Sonnet to save quota) |
| reasoningEffort | `medium` (routing does not need deep thinking) |
| initialMessage | `Introduce yourself in one line and list the agents on this team.` |

**description** (~900 characters, limit 2,000). Paste it verbatim:

```text
You run my OpenBot team: you create agents and route work to them. You never do the work yourself.

When a message asks for a new agent, call openbot.create_agent with exactly the arguments given. Do not rewrite the description. Then call openbot.read_agent to verify it. When a routine is requested, create it with openbot.create_routine for the new agent's id. End with the line "CREATED_AGENT_ID: <id>".

When a message is a task, pick the one teammate whose job fits (openbot.list_agents), hand the task to it, and report its answer back in a few lines. If no teammate fits, say so and propose a new agent (name + one-job line) instead of doing it.

Never: write code, browse, or run commands for a task; change another agent's settings unless asked; delete agents.

Voice: brief, factual, no filler. Reply in the language of the message. You work when asked.
```

Why it is written this way:

- It follows the **one job → anti-jobs → voice → wake** structure of OpenBot's "Agent Designer" skill.
- "Do not rewrite the description" and the `CREATED_AGENT_ID:` line match the message that the
  `create_agent` tool sends. The tool uses that line to confirm the agent was created.
- "You never do the work yourself" stops the Manager from doing a task itself when no teammate
  fits, so the roles stay separate.

### Steps

1. Open OpenBot. A fresh install likely comes with one default agent (the repo ships an
   "Eggbot Getting Started" skill for fresh installs).
2. Chat with that agent. OpenBot creates agents by having an agent call its tool in chat:

   > Use openbot.create_agent to create an agent named "Manager", title "Team dispatcher",
   > provider claude, model claude-opus-5-5, reasoningEffort medium, with this description verbatim:
   > *(paste the description above)*
   > initialMessage: "Introduce yourself in one line and list the agents on this team."
   > Then check the result with openbot.read_agent.

   If the app has a New agent button, you can enter the same values there instead.
3. Turn on **Manager → Settings → Permissions → Local scripts**.
4. Check from your MCP client: `openbot_status` (should show 1 agent), then
   `send_message("Manager", "list the team", wait=true)`.

### Next agents: create them through MCP

```text
create_agent(manager: "Manager", name: "Reviewer", job: "...", antiJobs: [...],
             voice: "...", initialMessage: "...", dryRun: true)    # preview + warnings
create_agent(..., dryRun: false)                                     # create it
```

Or use the `design_agent` prompt to have the client ask you a few questions and draft it.

New agents start with **Local scripts off**. You can either:

- turn Local scripts on for each one in the app, to direct it from MCP, or
- leave it off and go through the Manager: `send_message("Manager", "Give this to Reviewer: ...")`

## Install

```sh
npm install
npm run build
```

### Claude Code

```sh
claude mcp add openbot --scope user -- node "/path/to/openbot-mcp/dist/index.js"
```

### Claude Desktop / other clients (`mcpServers`)

```json
{
  "mcpServers": {
    "openbot": {
      "command": "node",
      "args": ["/path/to/openbot-mcp/dist/index.js"]
    }
  }
}
```

On Windows, use a full path such as `C:\\path\\to\\openbot-mcp\\dist\\index.js` (escape backslashes in JSON).

## Testing

**1. Automated (no OpenBot needed)**

```sh
npm test
```

This builds the project, then runs the real server (`dist/index.js`) over stdio against a mock OpenBot
(`test/mock-openbot.ts`) and checks 19 scenarios: every tool, question/approval flows, timeouts,
an OpenBot restart with a new token, read-only mode, and `create_agent`.

**2. By hand with the MCP Inspector (no OpenBot needed)**

```sh
# terminal 1
npm run mock

# terminal 2 (PowerShell)
$env:OPENBOT_AUTOMATION_DIR = "$PWD\.mock-openbot"
npm run inspect
# bash/zsh: OPENBOT_AUTOMATION_DIR="$PWD/.mock-openbot" npm run inspect
```

The mock has agents **Ada** (routine Wake) and **Bob**. Put these words in a message to trigger a case:

| Word | Result |
| --- | --- |
| `ASK` | the agent asks a question: try `get_pending` → `answer_prompt` |
| `APPROVE` | the agent requests an approval: try `respond_approval` |
| `SLOW` | the job never ends: tests timeouts and the 409 from `clear_context` |

**3. Against the real OpenBot**

Turn on Local scripts for an agent, check that `url`, `token` and `headers` exist in the automation
folder, then run `npm run inspect` without `OPENBOT_AUTOMATION_DIR` set. Start read-only
(`list_agents`, `send_message` with `wait=true`, `get_pending`, `create_agent` with `dryRun=true`)
before creating anything. `send_message` and `run_routine` count toward the hourly limit (see Limits).

## Tools

| Tool | Route | What it does |
| --- | --- | --- |
| `openbot_status` | `GET /v1/agents` | Checks that OpenBot is reachable |
| `list_agents` | `GET /v1/agents` | Lists agents and their routines |
| `send_message` | `POST /messages` (+ poll) | Sends a task. With `wait=true`, returns the answer or what the agent needs from a person |
| `send_to_agents` | `POST /messages` × N | Sends the same task to several agents at once |
| `get_delivery` | `GET /deliveries/:id` | Reads a delivery's status once |
| `wait_for_delivery` | `GET /deliveries/:id` + `/pending` | Waits until done, a person is needed, or timeout (sends progress notifications) |
| `run_routine` | `POST /routines/:id/run` | Runs a routine (by name or id) with an optional payload / `waitId` |
| `update_agent_settings` | `POST /settings` | Changes provider / model / effort / account |
| `clear_context` | `POST /context/clear` | Starts a new chat |
| `get_pending` | `GET /pending` | Lists questions, approvals and browser takeovers that wait for a person (no agent = all agents) |
| `answer_prompt` | `POST /prompts/:id/answer` | Answers a question |
| `respond_approval` | `POST /approvals/:id/respond` | Accepts or declines an approval |
| `create_agent` | `POST /messages` → manager agent | Drafts and checks a profile against the Agent Designer rules, then has a manager agent call `openbot.create_agent` (default `dryRun=true` = preview only) |

`agent` accepts an id or a name (case-insensitive). OpenBot errors (400–429) become tool errors with
an explanation and the response body (a 409 for a wrong model, for example, lists the valid models).

**Resources:** `openbot://agents`, `openbot://agents/{agentId}/pending`, `openbot://guides/create-agent`

**Prompts:** `delegate` (pick an agent, send the task, handle its questions), `triage_pending`
(walk through everything that is waiting), `design_agent` (short interview → draft persona → preview → create)

## Creating agents

The Local scripts API has no create route, so `create_agent` sends a step-by-step message to an
existing (manager) agent, which calls the built-in `openbot.create_agent` tool. The rules come from
the OpenBot repo (`profile-tools.ts`, `tool-guidance.ts`, the `agent-designer` skill):

- `description` is the whole persona, at most 2,000 characters, in the order
  **one job → anti-jobs → voice → wake**, followed by the concrete "how".
- `name` ≤ 80 characters, `title` ≤ 120, `initialMessage` (the first task) is required. Without
  provider/model/effort, the new agent uses the manager's.
- Routines are created by the manager with `openbot.create_routine`, not by the new agent itself.
- New agents have **Local scripts off**. Turn it on in the app before this server can see them.
- The manager replies with a `CREATED_AGENT_ID: <id>` line, which the tool uses to confirm success.

## Environment

| Variable | Default | Effect |
| --- | --- | --- |
| `OPENBOT_AUTOMATION_DIR` | per OS | Folder with `url`/`token` (e.g. a dev profile or the mock) |
| `OPENBOT_MCP_READONLY` | off | `1` = register only read tools (`create_agent` stays, preview only) |
| `OPENBOT_MCP_DISABLE_APPROVALS` | off | `1` = no `respond_approval` |
| `OPENBOT_MCP_WAIT_SECONDS` | `300` | Timeout for `wait=true` when none is given |

## Limits (from OpenBot itself)

- The listener binds `127.0.0.1`, so this server must run on the same computer as OpenBot, as the same OS user.
- `send_message` and `run_routine` share a limit of **30 requests per hour per agent** (change it in
  Server Settings › Agent defaults › Local scripts). Reads, answers, settings changes and new chats do not count.
- No attachments. Agent names and permissions cannot be changed through the API.
- Secret questions, browser takeovers and owner-only approvals must be handled in the OpenBot app
  (the API answers 403 / `requiresOpenBot`).
- An MCP timeout or cancel stops only the wait. The agent keeps working; use `wait_for_delivery` to resume.

## Layout

```
src/connection.ts          reads url/token, retries after an OpenBot restart, maps HTTP errors
src/api.ts                 typed wrapper for every route, resolves agents/routines by name
src/wait.ts                polls a delivery until done / needs a person / timeout / cancel
src/tools.ts               MCP tools, resources, prompts
src/agent-design.ts        agent creation rules (limits, enums, 4-part persona, manager message, guide)
src/agent-design-tools.ts  create_agent tool, design_agent prompt, guide resource
src/index.ts               stdio entry point and env flags
test/                      mock OpenBot, e2e smoke test (19 checks), run-mock helper
```

## License

[MIT](LICENSE)

// Keeps a mock OpenBot running so you can try the MCP server by hand (e.g. with the MCP Inspector).
import { join } from "node:path";
import { startMock } from "./mock-openbot.js";

const dir = process.argv[2] ?? join(process.cwd(), ".mock-openbot");
const mock = await startMock(dir);
console.log(`Mock OpenBot listening at ${mock.url}`);
console.log(`Automation files in: ${dir}`);
console.log("Agents: Ada (routine Wake), Bob. Put ASK / APPROVE / SLOW in a message to trigger a question / approval / long job.");
console.log(`\nIn another terminal:\n  set OPENBOT_AUTOMATION_DIR=${dir}\n  npm run inspect\n\nCtrl+C to stop.`);
process.on("SIGINT", async () => {
  await mock.close();
  process.exit(0);
});

import { processIdentity } from "../../src/index";
import { harness } from "../helpers";
const h = harness(process.argv[2]);
const { state } = await h.lifecycle.start(
  "codex",
  {
    session_id: process.argv[3],
    cwd: process.cwd(),
    hook_event_name: "SessionStart",
  },
  processIdentity(process.pid),
  { client_name: "codex" },
);
process.send?.(JSON.stringify(state));
setInterval(() => {}, 1000);

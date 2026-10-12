import { defineCommand } from "citty";
import {
  assertHumanCommand,
  humanRequest,
  humanSessionStore,
  loginWorkerUrl,
} from "../lib/human-login";
import { outputText } from "../lib/output";
export default defineCommand({
  meta: {
    name: "logout",
    description: "Revoke this CLI login and its browser sessions",
  },
  args: { url: { type: "string", description: "Tila server URL" } },
  async run({ args }) {
    assertHumanCommand();
    const url = loginWorkerUrl(args.url);
    const store = humanSessionStore();
    const session = await store.get(url);
    if (session) {
      try {
        await humanRequest(url, "/auth/sign-out", {}, session.token);
      } catch (error) {
        if ((error as { status?: number }).status !== 401) throw error;
      }
    }
    await store.delete(url);
    outputText("Signed out of this CLI.");
  },
});

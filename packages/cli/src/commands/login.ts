import { hostname } from "node:os";
import { defineCommand } from "citty";
import { openInBrowser } from "../lib/browser";
import {
  assertHumanCommand,
  humanRequest,
  humanSessionStore,
  loginWorkerUrl,
} from "../lib/human-login";
import { outputText } from "../lib/output";

export default defineCommand({
  meta: {
    name: "login",
    description: "Authorize this CLI with your tila account",
  },
  args: {
    url: { type: "string", description: "Tila server URL" },
    "no-browser": {
      type: "boolean",
      default: false,
      description: "Display the sign-in link without opening a browser",
    },
  },
  async run({ args }) {
    assertHumanCommand();
    const url = loginWorkerUrl(args.url);
    const store = humanSessionStore();
    const clientId = `tila-cli:${hostname()
      .replace(/[^\w .@()-]/g, "-")
      .slice(0, 100)}`;
    const request = await humanRequest<{
      device_code: string;
      user_code: string;
      verification_uri_complete: string;
      expires_in: number;
      interval: number;
    }>(url, "/auth/device/code", { client_id: clientId });
    outputText(
      `Open ${request.verification_uri_complete}\nConfirm code: ${request.user_code}`,
    );
    if (!args["no-browser"]) openInBrowser(request.verification_uri_complete);
    const deadline = Date.now() + request.expires_in * 1000;
    let interval = Math.max(5, request.interval) * 1000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, interval));
      try {
        const result = await humanRequest<{
          access_token: string;
          expires_in: number;
        }>(url, "/auth/device/token", {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: request.device_code,
          client_id: clientId,
        });
        try {
          await store.set(url, {
            token: result.access_token,
            expiresAt: Date.now() + result.expires_in * 1000,
          });
        } catch (error) {
          await humanRequest(
            url,
            "/auth/sign-out",
            {},
            result.access_token,
          ).catch(() => {});
          throw error;
        }
        outputText(
          "Signed in. Your login is stored in the OS credential store. Run tila open to open your dashboard.",
        );
        return;
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === "authorization_pending") continue;
        if (code === "slow_down") {
          interval += 5000;
          continue;
        }
        throw error;
      }
    }
    throw new Error("Device request expired. Run tila login again.");
  },
});

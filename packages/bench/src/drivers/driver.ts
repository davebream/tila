import type { RunOptions } from "../options";
import { isLocalHost } from "../region";
import type { Driver } from "../types";
import { createEmbeddedDriver } from "./embedded";
import { createHttpDriver } from "./http";
import { createInprocDriver } from "./inproc";

export function createDriver(opts: RunOptions, runId: string): Driver {
  switch (opts.tier) {
    case "inproc":
      return createInprocDriver({ runId });
    case "embedded":
      return createEmbeddedDriver({ runId });
    case "http": {
      if (!opts.baseUrl || !opts.token || !opts.projectId)
        throw new Error(
          "http tier needs TILA_BASE_URL, TILA_TOKEN and TILA_PROJECT_ID (or --base-url/--token/--project).",
        );
      if (!isLocalHost(opts.baseUrl) && !opts.allowRemote)
        throw new Error(
          `Refusing to load ${new URL(opts.baseUrl).host}: set TILA_BENCH_ALLOW_REMOTE=1 to benchmark a non-local deployment.`,
        );
      if (opts.participants > 64 && !opts.allowLarge)
        throw new Error(
          "More than 64 participants on the http tier needs --allow-large (mind Workers request quotas).",
        );
      return createHttpDriver({
        runId,
        baseUrl: opts.baseUrl,
        token: opts.token,
        tokens: opts.tokens,
        projectId: opts.projectId,
        sweepSecret: opts.sweepSecret,
        region: opts.region,
      });
    }
  }
}

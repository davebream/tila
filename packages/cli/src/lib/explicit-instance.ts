import type { InstanceKey, TilaProjectConfig } from "@tila/schemas";
import {
  AuthStore,
  KeyringSecretStore,
  TilaPaths,
  evaluateTrust,
  processEnvProbe,
} from "../auth-store";
import { type GlobalFlags, getGlobalFlags } from "./global-flags";

/**
 * Raised when an explicit --instance cannot be proved to be the deployment of
 * the project that a command would act on. Nothing has been sent when it is
 * thrown: the guard runs before credentials are read or a client is built.
 */
export class ExplicitInstanceTargetError extends Error {
  readonly code = "invalid-argument" as const;

  constructor(
    message: string,
    readonly hint: string,
  ) {
    super(message);
    this.name = "ExplicitInstanceTargetError";
  }
}

const SELECT_HINT =
  "Data commands act on the project in the current directory. Run from that instance's project directory, or omit --instance.";

type RegistryReader = Pick<AuthStore, "getInstance">;

function defaultRegistry(): RegistryReader {
  return new AuthStore({
    paths: new TilaPaths(),
    secrets: new KeyringSecretStore(),
    env: processEnvProbe,
  });
}

/**
 * Prove that an explicit --instance names the deployment of `config`, the
 * project a command is about to act on.
 *
 * The CLI resolves a project and Worker from the nearest .tila/config.toml and
 * cannot route one command to a different instance, so an explicit
 * --instance <key> is accepted only when all of these hold:
 *   - the project is remote (a local project has no instance);
 *   - <key> is a registered, trusted instance whose Worker URL is the
 *     project's `worker_url`;
 *   - the project's own instance pointer, when present, names <key>;
 *   - --project, when present, names this project.
 * Anything else is refused. Without --instance this is a no-op, so implicit
 * cwd behavior is unchanged.
 *
 * Only the registry file is read; no keychain access, no network.
 */
export async function assertExplicitInstanceTarget(
  config: TilaProjectConfig,
  flags: Pick<GlobalFlags, "instance" | "project"> = getGlobalFlags(),
  registry?: RegistryReader,
): Promise<void> {
  const key = flags.instance;
  if (key === undefined) return;
  const named = JSON.stringify(key);

  if (config.backend === "local")
    throw new ExplicitInstanceTargetError(
      `--instance ${named} cannot target the local project in this directory (local projects have no instance).`,
      SELECT_HINT,
    );
  if (!config.worker_url)
    throw new ExplicitInstanceTargetError(
      `--instance ${named} cannot be verified: the project in this directory has no worker_url.`,
      SELECT_HINT,
    );

  const record = await (registry ?? defaultRegistry()).getInstance(
    key as InstanceKey,
  );
  const decision = evaluateTrust(
    {
      worker_url: config.worker_url,
      instance_key: key as InstanceKey,
      inlineToken: false,
    },
    record,
  );
  if (decision.kind === "untrusted-needs-login")
    throw new ExplicitInstanceTargetError(
      decision.reason === "unregistered"
        ? `Unknown instance ${named}. --instance must name a registered instance.`
        : `Instance ${named} is registered but not trusted.`,
      decision.reason === "unregistered"
        ? "List registered instances with 'tila instances list', or omit --instance."
        : "Run 'tila auth login' to trust it, or omit --instance.",
    );
  if (decision.kind !== "trusted")
    throw new ExplicitInstanceTargetError(
      `--instance ${named} is a different deployment from the project in this directory.`,
      SELECT_HINT,
    );

  const pinned = config.instance?.instance_key;
  if (pinned !== undefined && pinned !== key)
    throw new ExplicitInstanceTargetError(
      `--instance ${named} conflicts with the project in this directory, which is pinned to instance ${JSON.stringify(pinned)}.`,
      SELECT_HINT,
    );

  if (flags.project !== undefined && flags.project !== config.project_id)
    throw new ExplicitInstanceTargetError(
      `--project ${JSON.stringify(flags.project)} is not the project in this directory (project_id is ${JSON.stringify(config.project_id)}), so --instance ${named} cannot be verified for it.`,
      SELECT_HINT,
    );
}

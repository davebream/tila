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
 * the project (or infrastructure) that a command would act on. Nothing has been
 * sent when it is thrown: the guards run before credentials are read, a client
 * is built, or anything local is changed.
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

type RegistryReader = Pick<AuthStore, "getInstance">;
type ExplicitFlags = Pick<GlobalFlags, "instance" | "project">;

/** What the command would act on, for messages and remediation. */
interface Subject {
  /** Noun phrase for "different deployment from <subject>". */
  noun: string;
  hint: string;
}

const DIRECTORY_PROJECT: Subject = {
  noun: "the project in this directory",
  hint: "Data commands act on the project in the current directory. Run from that instance's project directory, or omit --instance.",
};

const INFRA_WORKER: Subject = {
  noun: "the Worker in ~/.tila/infra.toml that infra-owner destroy acts on",
  hint: "Infra-owner destroy targets that Worker by slug and does not select an instance with --instance. Omit --instance, or name the instance whose Worker that is.",
};

function defaultRegistry(): RegistryReader {
  return new AuthStore({
    paths: new TilaPaths(),
    secrets: new KeyringSecretStore(),
    env: processEnvProbe,
  });
}

/** Registered, trusted, and its Worker URL is exactly `workerUrl`. */
async function assertInstanceIsWorker(
  key: string,
  workerUrl: string,
  subject: Subject,
  registry: RegistryReader | undefined,
): Promise<void> {
  const named = JSON.stringify(key);
  const record = await (registry ?? defaultRegistry()).getInstance(
    key as InstanceKey,
  );
  const decision = evaluateTrust(
    {
      worker_url: workerUrl,
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
      `--instance ${named} is a different deployment from ${subject.noun}.`,
      subject.hint,
    );
}

function assertProjectFlag(
  flags: ExplicitFlags,
  projectId: string,
  subject: Subject,
): void {
  if (flags.project === undefined || flags.project === projectId) return;
  throw new ExplicitInstanceTargetError(
    `--project ${JSON.stringify(flags.project)} is not the project this command targets (project_id is ${JSON.stringify(projectId)}), so --instance ${JSON.stringify(flags.instance)} cannot be verified for it.`,
    subject.hint,
  );
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
  flags: ExplicitFlags = getGlobalFlags(),
  registry?: RegistryReader,
): Promise<void> {
  const key = flags.instance;
  if (key === undefined) return;
  const named = JSON.stringify(key);

  if (config.backend === "local")
    throw new ExplicitInstanceTargetError(
      `--instance ${named} cannot target the local project in this directory (local projects have no instance).`,
      DIRECTORY_PROJECT.hint,
    );
  if (!config.worker_url)
    throw new ExplicitInstanceTargetError(
      `--instance ${named} cannot be verified: the project in this directory has no worker_url.`,
      DIRECTORY_PROJECT.hint,
    );

  await assertInstanceIsWorker(
    key,
    config.worker_url,
    DIRECTORY_PROJECT,
    registry,
  );

  const pinned = config.instance?.instance_key;
  if (pinned !== undefined && pinned !== key)
    throw new ExplicitInstanceTargetError(
      `--instance ${named} conflicts with the project in this directory, which is pinned to instance ${JSON.stringify(pinned)}.`,
      DIRECTORY_PROJECT.hint,
    );

  assertProjectFlag(flags, config.project_id, DIRECTORY_PROJECT);
}

/**
 * Infra-owner destroy by slug acts on the Worker saved in ~/.tila/infra.toml,
 * independent of any project in the current directory. --instance is never a
 * selector there: an explicit key is accepted only as an assertion that it is
 * that Worker's registered, trusted instance (and --project, when present,
 * is the slug); otherwise the destroy is refused before any credential is read.
 */
export async function assertExplicitInstanceIsInfraWorker(
  target: { workerUrl: string; slug: string },
  flags: ExplicitFlags = getGlobalFlags(),
  registry?: RegistryReader,
): Promise<void> {
  if (flags.instance === undefined) return;
  await assertInstanceIsWorker(
    flags.instance,
    target.workerUrl,
    INFRA_WORKER,
    registry,
  );
  assertProjectFlag(flags, target.slug, INFRA_WORKER);
}

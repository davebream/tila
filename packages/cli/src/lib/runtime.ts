import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  AuthStore,
  KeyringSecretStore,
  type RuntimeEnrollmentSecret,
  RuntimeEnrollmentStore,
  RuntimeFileSecretStore,
  TilaPaths,
  processEnvProbe,
} from "@tila/auth-store";
import {
  RuntimeBroker,
  SessionStore,
  generateRuntimeKey,
  runtimeBinding,
  runtimeEndpointPolicy,
} from "@tila/client-lifecycle";
import {
  type CredentialPolicy,
  InstanceKey as InstanceKeySchema,
} from "@tila/schemas";
import {
  RuntimeClient,
  TokenProviderError,
  assertRuntimeContext,
  exchangeRuntimeWorkload,
} from "tila-sdk";
import { requireTokenAsync } from "../auth";
import { findConfig } from "../config";
import { getGlobalFlags } from "./global-flags";

export interface RuntimeSelection {
  deployment: string;
  projectId: string;
}
export interface EnrollmentReference extends RuntimeSelection {
  instanceId: string;
  enrollmentId: string;
  fileStore?: string;
}
const authStore = () =>
  new AuthStore({
    paths: new TilaPaths(),
    secrets: new KeyringSecretStore(),
    env: processEnvProbe,
  });
export async function runtimeSelection(
  cwd?: string,
): Promise<RuntimeSelection> {
  const flags = getGlobalFlags();
  const config = findConfig(cwd);
  let deployment = config?.worker_url;
  if (flags.instance)
    deployment = /^https?:\/\//.test(flags.instance)
      ? flags.instance
      : (await authStore().getInstance(InstanceKeySchema.parse(flags.instance)))
          ?.worker_url;
  const projectId = flags.project ?? config?.project_id;
  if (!deployment || !projectId || config?.backend === "local")
    throw new TokenProviderError(
      "runtime-input-required",
      "Select a remote instance and project using --instance and --project, or configure this directory",
    );
  const url = new URL(deployment);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ))
  )
    throw new TokenProviderError(
      "runtime-binding-mismatch",
      "Runtime deployment must be an HTTPS origin (HTTP is allowed on loopback)",
    );
  return { deployment: url.origin, projectId };
}
async function referencePath(selection: RuntimeSelection) {
  const directory = join(new TilaPaths().home, "runtime");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return join(
    directory,
    `${createHash("sha256").update(JSON.stringify(selection)).digest("hex")}.json`,
  );
}
export async function enrollmentReference(
  selection: RuntimeSelection,
): Promise<EnrollmentReference | null> {
  try {
    const raw = JSON.parse(
      await readFile(await referencePath(selection), "utf8"),
    ) as EnrollmentReference;
    if (
      raw.deployment !== selection.deployment ||
      raw.projectId !== selection.projectId
    )
      throw new Error("Runtime reference binding changed");
    return raw;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
function enrollmentStore(reference: { fileStore?: string }) {
  return new RuntimeEnrollmentStore(
    reference.fileStore
      ? new RuntimeFileSecretStore(reference.fileStore)
      : new KeyringSecretStore(),
  );
}
export async function runtimeOperatorClient(selection: RuntimeSelection) {
  if (process.env.TILA_RUN_SOCKET || process.env.TILA_RUN_CAPABILITY)
    throw new TokenProviderError(
      "runtime-purpose-denied",
      "Managed runs cannot use operator authentication",
    );
  const flags = getGlobalFlags();
  const saved =
    flags.instance && !/^https?:\/\//.test(flags.instance)
      ? await authStore().getCredential(InstanceKeySchema.parse(flags.instance))
      : null;
  const token = flags.token ?? saved?.token ?? (await requireTokenAsync());
  return new RuntimeClient(
    { baseUrl: selection.deployment, token },
    selection.projectId,
  );
}
async function enrollMachineUnlocked(
  options: {
    name?: string;
    fileStore?: string;
    invitation?: string;
    policy?: CredentialPolicy;
  } = {},
) {
  const selection = await runtimeSelection();
  const infoResponse = await fetch(`${selection.deployment}/api/runtime/info`, {
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  const info = (await infoResponse.json().catch(() => ({}))) as {
    protocol?: number;
    instance_id?: string;
  };
  if (!infoResponse.ok || info.protocol !== 1 || !info.instance_id)
    throw new TokenProviderError(
      "runtime-server-incompatible",
      "Upgrade the backend to tila 0.4.0 before enrollment",
    );
  let reference = await enrollmentReference(selection);
  if (
    reference &&
    (reference.instanceId !== info.instance_id ||
      (options.fileStore !== undefined &&
        reference.fileStore !== options.fileStore))
  )
    throw new TokenProviderError(
      "runtime-binding-mismatch",
      "Existing installation belongs to a different deployment or secret store",
    );
  const created = !reference;
  reference ??= {
    ...selection,
    instanceId: info.instance_id,
    enrollmentId: randomUUID(),
    fileStore: options.fileStore,
  };
  const store = enrollmentStore(reference);
  await store.probe();
  if (created) {
    const target = await referencePath(selection);
    const temporary = `${target}.${randomUUID()}`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(reference));
        await file.sync();
      } finally {
        await file.close();
      }
      // Publish a complete operation reference atomically without overwriting
      // another setup attempt. No remote mutation precedes this durable write.
      await link(temporary, target);
      const directory = await open(dirname(target), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      reference = await enrollmentReference(selection);
      if (!reference) throw new Error("Enrollment reference disappeared");
    } finally {
      await rm(temporary, { force: true });
    }
  }
  let secret = await store.get(
    reference.instanceId,
    reference.projectId,
    reference.enrollmentId,
  );
  if (!secret) {
    secret = {
      ...reference,
      version: 1,
      installationId: randomUUID(),
      privateJwk: await generateRuntimeKey(),
    };
    // Operation ID and key are durable before the first remote mutation.
    await store.save(secret);
  }
  const binding = await runtimeBinding(
    secret.privateJwk,
    selection.deployment,
    runtimeEndpointPolicy(selection.projectId, "enrollment"),
  );
  if (secret.token) {
    const token = secret.token;
    const api = new RuntimeClient(
      {
        baseUrl: selection.deployment,
        token: async () => ({ token, dpop: binding }),
      },
      selection.projectId,
    );
    const context = await api.context();
    assertRuntimeContext(context, {
      instance_id: reference.instanceId,
      project_id: reference.projectId,
      purpose: "enrollment",
      enrollment_id: reference.enrollmentId,
    });
    return reference;
  }
  const api = options.invitation
    ? new RuntimeClient(
        { baseUrl: selection.deployment, token: options.invitation },
        selection.projectId,
      )
    : await runtimeOperatorClient(selection);
  const result = await api.enroll(
    {
      operation_id: reference.enrollmentId,
      installation_id: secret.installationId,
      name: options.name ?? hostname(),
      jkt: binding.jkt,
      policy: options.policy,
    },
    binding,
    options.invitation,
  );
  assertRuntimeContext(result.context, {
    instance_id: reference.instanceId,
    project_id: reference.projectId,
    purpose: "enrollment",
    enrollment_id: reference.enrollmentId,
  });
  await store.save({ ...secret, token: result.token });
  return reference;
}
export async function startEnrolledRun(
  selection: RuntimeSelection,
  policy?: CredentialPolicy,
) {
  const reference = await enrollmentReference(selection);
  if (!reference)
    throw new TokenProviderError(
      "runtime-enrollment-required",
      "Run tila machine enroll before starting unattended sessions",
    );
  const secret: RuntimeEnrollmentSecret | null = await enrollmentStore(
    reference,
  ).get(reference.instanceId, reference.projectId, reference.enrollmentId);
  if (!secret?.token)
    throw new TokenProviderError(
      "runtime-enrollment-recovery-required",
      "Enrollment setup is incomplete; rerun tila machine enroll with the original authorization",
    );
  const parentToken = secret.token;
  const parentBinding = await runtimeBinding(
    secret.privateJwk,
    selection.deployment,
    runtimeEndpointPolicy(selection.projectId, "enrollment"),
  );
  const api = new RuntimeClient(
    {
      baseUrl: selection.deployment,
      token: async () => ({ token: parentToken, dpop: parentBinding }),
    },
    selection.projectId,
  );
  assertRuntimeContext(await api.context(), {
    instance_id: reference.instanceId,
    project_id: selection.projectId,
    purpose: "enrollment",
    enrollment_id: reference.enrollmentId,
  });
  const binding = await runtimeBinding(
    await generateRuntimeKey(),
    selection.deployment,
    runtimeEndpointPolicy(selection.projectId, "run"),
  );
  const operation = { operation_id: randomUUID(), jkt: binding.jkt, policy };
  let value: Awaited<ReturnType<RuntimeClient["start"]>> | undefined;
  for (let attempt = 0; ; attempt++) {
    try {
      value = await api.start(operation);
      break;
    } catch (error) {
      if (
        attempt >= 3 ||
        !(
          error instanceof TypeError ||
          (error instanceof Error && error.name === "TimeoutError") ||
          (error &&
            typeof error === "object" &&
            "retryable" in error &&
            error.retryable === true)
        )
      )
        throw error;
      await delay(250 * 2 ** attempt);
    }
  }
  assertRuntimeContext(value.context, {
    instance_id: reference.instanceId,
    project_id: selection.projectId,
    purpose: "run",
    enrollment_id: reference.enrollmentId,
  });
  const runId = value.context.run_id;
  const broker = new RuntimeBroker(selection.deployment, value, binding, {
    async renew(expected) {
      try {
        return await api.renew(runId, expected);
      } catch (error) {
        // An ambiguous response is recovered through the parent, never by a
        // plaintext retry cache. Terminal authorization errors remain terminal.
        if (
          !(
            error instanceof TypeError ||
            (error instanceof Error && error.name === "TimeoutError")
          ) &&
          !(
            error &&
            typeof error === "object" &&
            "code" in error &&
            ["runtime-renewal-conflict", "runtime-conflict"].includes(
              String(error.code),
            )
          )
        )
          throw error;
        const latest = (await api.runs()).runs.find(
          (run) => run.run_id === runId,
        );
        if (!latest) throw error;
        return api.renew(latest.run_id, latest.current_token_id);
      }
    },
    heartbeat: () => api.heartbeat(runId),
    close: () => api.close(runId),
  });
  try {
    return { broker, reference: await broker.listen() };
  } catch (error) {
    await broker.close().catch(() => {});
    throw error;
  }
}

export async function enrollMachine(
  options: Parameters<typeof enrollMachineUnlocked>[0] = {},
) {
  const selection = await runtimeSelection();
  const key = createHash("sha256")
    .update(JSON.stringify(selection))
    .digest("hex");
  return new SessionStore(
    join(new TilaPaths().home, "runtime-setup-locks"),
  ).locked(key, () => enrollMachineUnlocked(options));
}

export async function startOidcRun(
  selection: RuntimeSelection,
  policy?: CredentialPolicy,
) {
  const operationId = randomUUID();
  const ordinary = runtimeEndpointPolicy(selection.projectId, "run");
  const root = `/projects/${encodeURIComponent(selection.projectId)}/runtime/runs/${operationId}/`;
  const binding = await runtimeBinding(
    await generateRuntimeKey(),
    selection.deployment,
    (path, method) =>
      ordinary(path, method) ||
      (method === "POST" &&
        (path === "/api/auth/oidc/exchange" ||
          path === `${root}heartbeat` ||
          path === `${root}close`)),
  );
  async function exchange() {
    const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
    const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    if (!requestUrl || !requestToken)
      throw new TokenProviderError(
        "runtime-oidc-unavailable",
        "GitHub Actions OIDC requires id-token: write; other pipelines should enroll a shared runner",
      );
    const url = new URL(requestUrl);
    if (url.protocol !== "https:" || url.username || url.password)
      throw new Error("Invalid OIDC assertion endpoint");
    url.searchParams.set("audience", selection.deployment);
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${requestToken}` },
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok)
      throw new TokenProviderError(
        "runtime-oidc-unavailable",
        "Could not obtain a fresh workload assertion",
        response.status >= 500,
      );
    const body = (await response.json()) as { value?: string };
    if (!body.value) throw new Error("Invalid OIDC assertion response");
    return exchangeRuntimeWorkload({
      baseUrl: selection.deployment,
      projectId: selection.projectId,
      operationId,
      assertion: body.value,
      binding,
      policy,
    });
  }
  let value = await exchange();
  const api = new RuntimeClient(
    {
      baseUrl: selection.deployment,
      token: async () => ({ token: value.token, dpop: binding }),
      participantId: value.context.participant_id,
    },
    selection.projectId,
  );
  const broker = new RuntimeBroker(selection.deployment, value, binding, {
    renew: async () => {
      value = await exchange();
      return value;
    },
    heartbeat: () => api.heartbeat(operationId),
    close: () => api.close(operationId),
  });
  try {
    return { broker, reference: await broker.listen() };
  } catch (error) {
    await broker.close().catch(() => {});
    throw error;
  }
}

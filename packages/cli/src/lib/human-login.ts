import {
  HumanSessionStore,
  KeyringSecretStore,
  canonicalizeWorkerUrl,
} from "../auth-store";
import { findConfig } from "../config";
export function assertHumanCommand() {
  if (
    process.env.TILA_RUN_SOCKET ||
    process.env.TILA_RUN_CAPABILITY ||
    process.env.TILA_LIFECYCLE_KEY ||
    process.env.CODEX_THREAD_ID ||
    process.env.CI
  ) {
    throw new Error(
      "Human login credentials are unavailable to managed runtimes and CI. Use a scoped API credential.",
    );
  }
}
export function humanSessionStore() {
  return new HumanSessionStore(new KeyringSecretStore());
}
export function loginWorkerUrl(explicit?: string) {
  const url = explicit ?? findConfig()?.worker_url;
  if (!url)
    throw new Error(
      "Provide --url or configure this project's worker_url first",
    );
  const normalized = canonicalizeWorkerUrl(url);
  const parsed = new URL(normalized);
  if (
    parsed.protocol !== "https:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)
  )
    throw new Error("Account login requires HTTPS (except localhost)");
  return normalized;
}
export async function humanRequest<T>(
  url: string,
  path: string,
  body?: unknown,
  token?: string,
  method = body === undefined ? "GET" : "POST",
) {
  const response = await fetch(`${url}/api/account${path}`, {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await response.json()) as T & {
    error?: string | { message: string };
    message?: string;
    error_description?: string;
  };
  if (!response.ok)
    throw Object.assign(
      new Error(
        typeof data.error === "object"
          ? data.error.message
          : (data.error_description ??
              data.message ??
              data.error ??
              "Account request failed"),
      ),
      { code: data.error, status: response.status },
    );
  return data;
}

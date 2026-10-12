import { API_BASE_URL } from "./config";
export async function accountRequest<T = { ok: boolean }>(
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
): Promise<T> {
  const response = await fetch(`${API_BASE_URL}/api/account${path}`, {
    method,
    credentials: "include",
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      data.error?.message ?? data.message ?? "Account request failed",
    );
  return data as T;
}
export type {
  HumanAccountUser as AccountUser,
  HumanAccountInfo as AccountInfo,
} from "@tila/schemas";

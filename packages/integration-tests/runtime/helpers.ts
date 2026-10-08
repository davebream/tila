export const identity = {
  principal_id: "runtime-principal",
  participant_id: "runtime-worker",
  environment: {},
};

export async function post(
  stub: DurableObjectStub,
  path: string,
  body: Record<string, unknown>,
) {
  const response = await stub.fetch(`https://project${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...identity, ...body }),
  });
  // Drain service-binding bodies before eviction waits for in-flight requests.
  return new Response(await response.arrayBuffer(), {
    status: response.status,
    headers: response.headers,
  });
}

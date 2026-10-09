import { RuntimeStore } from "@tila/backend-d1";
import { decodeJwt } from "jose";
import { hashToken } from "./hash";

const consumed = new WeakSet<Request>();

/** Call only after signature, key, URL, method, time and token binding validation. */
export async function consumeRuntimeProof(
  db: D1Database,
  jkt: string,
  proof: string,
  request: Request,
) {
  if (consumed.has(request)) return;
  const { jti } = decodeJwt(proof);
  await new RuntimeStore(db).consumeProof(
    await hashToken(`${jkt}:${jti}`, undefined),
  );
  consumed.add(request);
}

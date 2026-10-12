import { decodeJwt } from "jose";
import { RuntimeStore } from "../d1";
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

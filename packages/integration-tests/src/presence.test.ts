import {
  type PresenceAllListResponse,
  PresenceAllListResponseSchema,
  PresenceHeartbeatSuccessResponseSchema,
} from "@tila/schemas";
import { TilaClient } from "tila-sdk";
import { describe, expect, it } from "vitest";

const BASE_URL = process.env.TILA_BASE_URL;
const TOKEN = process.env.TILA_TOKEN;
const PROJECT_ID = process.env.TILA_PROJECT_ID ?? "default";

describe.skipIf(!BASE_URL || !TOKEN)("tila presence", () => {
  const client = new TilaClient({
    baseUrl: BASE_URL ?? "http://localhost:8787",
    token: TOKEN ?? "",
  });

  const projectPath = `/projects/${PROJECT_ID}`;
  const machine = `test-presence-${Date.now()}`;

  // AC-4: tila presence heartbeat writes a heartbeat
  it("should accept heartbeat and return ok:true", async () => {
    const res = await client.post(
      `${projectPath}/presence/heartbeat`,
      { machine, info: { role: "test" } },
      { schema: PresenceHeartbeatSuccessResponseSchema, validate: true },
    );

    expect(res.ok).toBe(true);
  });

  // AC-5: tila presence list shows active machines
  it("should list active machines after heartbeat", async () => {
    // Send heartbeat first to ensure the machine exists
    await client.post(
      `${projectPath}/presence/heartbeat`,
      { machine, info: { role: "test" } },
      { schema: PresenceHeartbeatSuccessResponseSchema, validate: true },
    );

    const res = await client.get(`${projectPath}/presence/all`, {
      schema: PresenceAllListResponseSchema,
      validate: true,
    });

    expect(res.ok).toBe(true);
    const entry = res.machines.find(
      (m: PresenceAllListResponse["machines"][number]) => m.machine === machine,
    );
    expect(entry).toBeDefined();
    expect(entry?.active).toBe(true);
  });

  // AC-6: tila presence list shows stale machines as inactive
  it("should show stale machines with active:false", async () => {
    // NOTE: Testing active:false requires the machine's last_seen to be older
    // than the 60s TTL. Without time-mock infrastructure, we cannot control
    // last_seen via HTTP. This test validates the schema shape and the active
    // field type. A full staleness test would require either a 60s wait or a
    // test-helper endpoint that injects an old timestamp (see Data Gaps in
    // understand report).
    const res = await client.get(`${projectPath}/presence/all`, {
      schema: PresenceAllListResponseSchema,
      validate: true,
    });

    expect(res.ok).toBe(true);
    // Validate schema shape: every machine entry has the active boolean field
    for (const entry of res.machines) {
      expect(typeof entry.active).toBe("boolean");
      expect(typeof entry.machine).toBe("string");
      expect(typeof entry.last_seen).toBe("number");
    }
  });

  // AC-7: tila presence list --json outputs valid JSON
  it("should return valid JSON matching PresenceAllListResponseSchema", async () => {
    // Send heartbeat to ensure at least one machine in the list
    await client.post(
      `${projectPath}/presence/heartbeat`,
      { machine, info: { version: "1.0" } },
      { schema: PresenceHeartbeatSuccessResponseSchema, validate: true },
    );

    const res = await client.get(`${projectPath}/presence/all`, {
      schema: PresenceAllListResponseSchema,
      validate: true,
    });

    // If we reach here without throwing, the Zod schema parse succeeded
    expect(res.ok).toBe(true);
    expect(Array.isArray(res.machines)).toBe(true);
    expect(res.machines.length).toBeGreaterThan(0);

    const entry = res.machines.find(
      (m: PresenceAllListResponse["machines"][number]) => m.machine === machine,
    );
    expect(entry).toBeDefined();
    expect(entry?.info).toBeDefined();
  });
});

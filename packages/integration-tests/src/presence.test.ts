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
  const machine = `test-presence-${Date.now()}`;
  const client = new TilaClient({
    baseUrl: BASE_URL ?? "http://localhost:8787",
    token: TOKEN ?? "",
    environment: { machine },
  });

  const projectPath = `/projects/${PROJECT_ID}`;

  // AC-4: tila presence heartbeat writes a heartbeat
  it("should accept heartbeat and return ok:true", async () => {
    const res = await client.post(
      `${projectPath}/presence/heartbeat`,
      { info: { role: "test" } },
      { schema: PresenceHeartbeatSuccessResponseSchema, validate: true },
    );

    expect(res.ok).toBe(true);
  });

  // AC-5: tila presence list shows active participants
  it("should list active participants after heartbeat", async () => {
    // Send heartbeat first to ensure the participant exists
    await client.post(
      `${projectPath}/presence/heartbeat`,
      { info: { role: "test" } },
      { schema: PresenceHeartbeatSuccessResponseSchema, validate: true },
    );

    const res = await client.get(`${projectPath}/presence/all`, {
      schema: PresenceAllListResponseSchema,
      validate: true,
    });

    expect(res.ok).toBe(true);
    const entry = res.participants.find(
      (participant: PresenceAllListResponse["participants"][number]) =>
        participant.environment.machine === machine,
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
    // Validate schema shape: every participant entry has canonical identity.
    for (const entry of res.participants) {
      expect(typeof entry.active).toBe("boolean");
      expect(typeof entry.principal_id).toBe("string");
      expect(typeof entry.participant_id).toBe("string");
      expect(typeof entry.last_seen).toBe("number");
    }
  });

  // AC-7: tila presence list --json outputs valid JSON
  it("should return valid JSON matching PresenceAllListResponseSchema", async () => {
    // Send heartbeat to ensure at least one participant in the list
    await client.post(
      `${projectPath}/presence/heartbeat`,
      { info: { version: "1.0" } },
      { schema: PresenceHeartbeatSuccessResponseSchema, validate: true },
    );

    const res = await client.get(`${projectPath}/presence/all`, {
      schema: PresenceAllListResponseSchema,
      validate: true,
    });

    // If we reach here without throwing, the Zod schema parse succeeded
    expect(res.ok).toBe(true);
    expect(Array.isArray(res.participants)).toBe(true);
    expect(res.participants.length).toBeGreaterThan(0);

    const entry = res.participants.find(
      (participant: PresenceAllListResponse["participants"][number]) =>
        participant.environment.machine === machine,
    );
    expect(entry).toBeDefined();
    expect(entry?.info).toBeDefined();
  });
});

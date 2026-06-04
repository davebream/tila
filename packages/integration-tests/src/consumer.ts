import {
  type AcquireSuccessResponse,
  AcquireSuccessResponseSchema,
  EntityArtifactReferenceListResponseSchema,
  EntityResponseSchema,
  ReleaseSuccessResponseSchema,
  StateResponseSchema,
} from "@tila/schemas";
import { TilaClient } from "tila-sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const BASE_URL = process.env.TILA_BASE_URL;
const TOKEN = process.env.TILA_TOKEN;
const PROJECT_ID = process.env.TILA_PROJECT_ID ?? "default";

// Response schema for artifact upload (not in @tila/schemas public API)
const ArtifactUploadResponseSchema = z.object({
  ok: z.literal(true),
  key: z.string(),
  bytes: z.number(),
  deduplicated: z.boolean(),
});
type ArtifactUploadResponse = z.infer<typeof ArtifactUploadResponseSchema>;

// Generic ok response for relationship/ref creation endpoints
const OkResponseSchema = z.object({
  ok: z.literal(true),
});
type OkResponse = z.infer<typeof OkResponseSchema>;

describe.skipIf(!BASE_URL || !TOKEN)(
  "Framework consumer: full task lifecycle",
  () => {
    // TilaClient is constructed lazily so instantiation doesn't run when env vars are absent.
    // The describe.skipIf guard above prevents it() bodies from executing, but the describe
    // callback itself still runs for test collection — so we must not throw in this scope.
    const client = new TilaClient({
      baseUrl: BASE_URL ?? "http://localhost:8787",
      token: TOKEN ?? "",
    });

    // Shared state across sequential steps
    const taskId = `consumer-task-${Date.now()}`;
    const projectPath = `/projects/${PROJECT_ID}`;
    let fence: number;
    let planKey: string;
    let patchKey: string;
    let reviewKey: string;

    it("Step 1: create task entity", async () => {
      const res = await client.post(
        `${projectPath}/entities`,
        {
          id: taskId,
          type: "task",
          data: { title: "consumer lifecycle test" },
          created_by: "consumer-script",
        },
        { schema: EntityResponseSchema, validate: true },
      );

      expect(res.ok).toBe(true);
      expect(res.entity.id).toBe(taskId);
      expect(res.entity.type).toBe("task");
    });

    it("Step 2: acquire exclusive claim", async () => {
      const res = await client.post<AcquireSuccessResponse>(
        `${projectPath}/claims/acquire`,
        {
          resource: `task:${taskId}`,
          mode: "exclusive",
          ttl_ms: 60_000,
        },
        { schema: AcquireSuccessResponseSchema, validate: true },
      );

      expect(res.ok).toBe(true);
      expect(res.fence).toBeGreaterThan(0);
      expect(res.expires_at).toBeGreaterThan(Date.now());
      fence = res.fence;
    });

    it("Step 3a: upload plan artifact", async () => {
      const formData = new FormData();
      formData.append(
        "file",
        new File(["# Plan\n\nThis is the plan artifact."], "plan.md", {
          type: "text/markdown",
        }),
      );
      formData.append("kind", "produced");
      formData.append("resource", taskId);
      formData.append("fence", String(fence));
      formData.append("mime_type", "text/markdown");

      const res = await client.postFormData<ArtifactUploadResponse>(
        `${projectPath}/artifacts`,
        formData,
        { schema: ArtifactUploadResponseSchema, validate: true },
      );

      expect(res.ok).toBe(true);
      expect(res.key).toMatch(/^produced\//);
      expect(res.bytes).toBeGreaterThan(0);
      planKey = res.key;
    });

    it("Step 3b: upload patch artifact", async () => {
      const formData = new FormData();
      formData.append(
        "file",
        new File(
          ["// Patch content\nexport function fix() { return true; }"],
          "patch.ts",
          { type: "text/plain" },
        ),
      );
      formData.append("kind", "produced");
      formData.append("resource", taskId);
      formData.append("fence", String(fence));
      formData.append("mime_type", "text/plain");

      const res = await client.postFormData<ArtifactUploadResponse>(
        `${projectPath}/artifacts`,
        formData,
        { schema: ArtifactUploadResponseSchema, validate: true },
      );

      expect(res.ok).toBe(true);
      expect(res.key).toMatch(/^produced\//);
      patchKey = res.key;
    });

    it("Step 3c: upload review artifact", async () => {
      const formData = new FormData();
      formData.append(
        "file",
        new File(["# Review\n\nPatch looks good. Approved."], "review.md", {
          type: "text/markdown",
        }),
      );
      formData.append("kind", "produced");
      formData.append("resource", taskId);
      formData.append("fence", String(fence));
      formData.append("mime_type", "text/markdown");

      const res = await client.postFormData<ArtifactUploadResponse>(
        `${projectPath}/artifacts`,
        formData,
        { schema: ArtifactUploadResponseSchema, validate: true },
      );

      expect(res.ok).toBe(true);
      expect(res.key).toMatch(/^produced\//);
      reviewKey = res.key;
    });

    it("Step 4a: add relationship -- patch references plan", async () => {
      const res = await client.post<OkResponse>(
        `${projectPath}/artifacts/relationship`,
        {
          from_key: patchKey,
          to_key: planKey,
          type: "references",
        },
        { schema: OkResponseSchema, validate: true },
      );

      expect(res.ok).toBe(true);
    });

    it("Step 4b: add relationship -- review derived-from patch", async () => {
      const res = await client.post<OkResponse>(
        `${projectPath}/artifacts/relationship`,
        {
          from_key: reviewKey,
          to_key: patchKey,
          type: "derived-from",
        },
        { schema: OkResponseSchema, validate: true },
      );

      expect(res.ok).toBe(true);
    });

    it("Step 5a: add entity-artifact ref -- plan slot", async () => {
      const res = await client.post<OkResponse>(
        `${projectPath}/entities/${taskId}/artifact-refs`,
        {
          artifact_key: planKey,
          slot: "plan",
          metadata: {},
        },
        { schema: OkResponseSchema, validate: true },
      );

      expect(res.ok).toBe(true);
    });

    it("Step 5b: add entity-artifact ref -- patch slot", async () => {
      const res = await client.post<OkResponse>(
        `${projectPath}/entities/${taskId}/artifact-refs`,
        {
          artifact_key: patchKey,
          slot: "patch",
          metadata: {},
        },
        { schema: OkResponseSchema, validate: true },
      );

      expect(res.ok).toBe(true);
    });

    it("Step 5c: add entity-artifact ref -- review slot", async () => {
      const res = await client.post<OkResponse>(
        `${projectPath}/entities/${taskId}/artifact-refs`,
        {
          artifact_key: reviewKey,
          slot: "review",
          metadata: {},
        },
        { schema: OkResponseSchema, validate: true },
      );

      expect(res.ok).toBe(true);
    });

    it("Step 6: verify entity-artifact refs", async () => {
      const res = await client.get(
        `${projectPath}/entities/${taskId}/artifact-refs`,
        { schema: EntityArtifactReferenceListResponseSchema, validate: true },
      );

      expect(res.ok).toBe(true);
      expect(res.references).toHaveLength(3);

      const slots = res.references.map((r) => r.slot);
      expect(slots).toContain("plan");
      expect(slots).toContain("patch");
      expect(slots).toContain("review");
    });

    it("Step 7: release claim", async () => {
      const res = await client.post<OkResponse>(
        `${projectPath}/claims/release`,
        {
          resource: `task:${taskId}`,
          fence,
        },
        { schema: ReleaseSuccessResponseSchema, validate: true },
      );

      expect(res.ok).toBe(true);
    });

    it("Step 8: verify claim released", async () => {
      const res = await client.get(
        `${projectPath}/claims/state/task:${taskId}`,
        { schema: StateResponseSchema, validate: true },
      );

      expect(res.ok).toBe(true);
      expect(res.claim).toBeNull();
    });
  },
);

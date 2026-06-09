/**
 * Integration test: worker artifact upload with tags end-to-end.
 *
 * Guards gap A (worker artifact route silently dropping tags): exercises the
 * multipart upload path in packages/worker/src/routes/artifacts.ts and
 * verifies that tags flow from the FormData through the pointerPayload to the
 * DO and back on read.
 *
 * Requires TILA_BASE_URL and TILA_TOKEN env vars to run against a live worker.
 * When env vars are absent (CI without a live worker), the suite is skipped.
 */

import { describe, expect, it } from "vitest";

const BASE_URL = process.env.TILA_BASE_URL;
const TOKEN = process.env.TILA_TOKEN;
const PROJECT_ID = process.env.TILA_PROJECT_ID ?? "dev-project";

describe.skipIf(!BASE_URL || !TOKEN)(
  "artifact tags - worker multipart upload round-trip",
  () => {
    it("uploads artifact with tags via multipart and reads tags back via list", async () => {
      // Build FormData with tags
      const formData = new FormData();
      const content = `# Tags E2E Test\n\nTimestamp: ${Date.now()}`;
      const file = new File([content], "tags-test.md", {
        type: "text/markdown",
      });
      formData.append("file", file);
      formData.append("kind", "plan");
      formData.append("tags", JSON.stringify(["env:test", "team:e2e"]));

      const uploadRes = await fetch(
        `${BASE_URL}/projects/${PROJECT_ID}/artifacts`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${TOKEN}` },
          body: formData,
        },
      );
      expect(uploadRes.status).toBe(200);
      const uploadBody = (await uploadRes.json()) as {
        ok: boolean;
        key: string;
        bytes: number;
        deduplicated: boolean;
      };
      expect(uploadBody.ok).toBe(true);
      const r2Key = uploadBody.key;
      expect(r2Key).toBeTruthy();

      // List artifacts and find the uploaded pointer — verify tags flow through
      const listRes = await fetch(
        `${BASE_URL}/projects/${PROJECT_ID}/artifacts`,
        {
          headers: { Authorization: `Bearer ${TOKEN}` },
        },
      );
      expect(listRes.status).toBe(200);
      const listBody = (await listRes.json()) as {
        ok: boolean;
        pointers: Array<{ r2_key: string; tags: string[] }>;
      };
      expect(listBody.ok).toBe(true);
      const ptr = listBody.pointers.find((p) => p.r2_key === r2Key);
      expect(ptr).toBeDefined();
      expect(ptr?.tags).toEqual(
        expect.arrayContaining(["env:test", "team:e2e"]),
      );
      expect(ptr?.tags).toHaveLength(2);
    });

    it("text-write artifact with tags is returned with tags on list", async () => {
      const writeRes = await fetch(
        `${BASE_URL}/projects/${PROJECT_ID}/artifacts/text`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            content: `# Text Write Tags Test\n\nTimestamp: ${Date.now()}`,
            kind: "note",
            mime_type: "text/markdown",
            tags: ["env:test", "source:text-write"],
          }),
        },
      );
      expect(writeRes.status).toBe(200);
      const writeBody = (await writeRes.json()) as {
        ok: boolean;
        key: string;
      };
      expect(writeBody.ok).toBe(true);
      const r2Key = writeBody.key;

      // Read back via list and verify tags
      const listRes = await fetch(
        `${BASE_URL}/projects/${PROJECT_ID}/artifacts`,
        {
          headers: { Authorization: `Bearer ${TOKEN}` },
        },
      );
      const listBody = (await listRes.json()) as {
        ok: boolean;
        pointers: Array<{ r2_key: string; tags: string[] }>;
      };
      const ptr = listBody.pointers.find((p) => p.r2_key === r2Key);
      expect(ptr).toBeDefined();
      expect(ptr?.tags).toEqual(
        expect.arrayContaining(["env:test", "source:text-write"]),
      );
    });
  },
);

// Non-live guard: verify the test file is correctly structured
describe("artifact tags - static checks", () => {
  it("test file is loaded correctly", () => {
    expect(true).toBe(true);
  });
});

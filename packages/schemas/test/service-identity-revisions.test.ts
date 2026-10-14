import { expect, it } from "vitest";
import {
  CREDENTIAL_PRESETS,
  ServiceAccountSchema,
  ServiceAccountUpdateRequestSchema,
  WorkloadBindingSchema,
  WorkloadBindingUpdateRequestSchema,
} from "../src/capability";

it("accepts optional safe integer preconditions without inventing a revision", () => {
  const service = { display_name: "CI" };
  const binding = { policy: CREDENTIAL_PRESETS.worker };
  for (const [schema, input] of [
    [ServiceAccountUpdateRequestSchema, service],
    [WorkloadBindingUpdateRequestSchema, binding],
  ] as const) {
    expect(schema.parse(input)).not.toHaveProperty("expected_revision");
    expect(schema.parse({ ...input, expected_revision: 7 })).toHaveProperty(
      "expected_revision",
      7,
    );
    for (const expected_revision of [
      0,
      -1,
      1.5,
      "1",
      null,
      Number.MAX_SAFE_INTEGER + 1,
    ])
      expect(schema.safeParse({ ...input, expected_revision }).success).toBe(
        false,
      );
    expect(schema.safeParse({ ...input, unexpected: "ignored" }).success).toBe(
      false,
    );
  }
});

it("requires revision metadata in both public response shapes", () => {
  const account = {
    principal_id: "service:ci",
    project_id: "p",
    name: "ci",
    display_name: "CI",
    created_at: 1,
    created_by: "fixture",
    revoked_at: null,
  };
  const binding = {
    ...account,
    binding_id: "ci",
    provider: "oidc",
    issuer: "https://issuer.example",
    subject: "ci",
    policy: CREDENTIAL_PRESETS.worker,
  };
  expect(ServiceAccountSchema.safeParse(account).success).toBe(false);
  expect(ServiceAccountSchema.parse({ ...account, revision: 1 }).revision).toBe(
    1,
  );
  expect(WorkloadBindingSchema.safeParse(binding).success).toBe(false);
  // Account-only display metadata is not part of a binding response.
  const { display_name: _display, ...bindingFields } = binding;
  expect(
    WorkloadBindingSchema.parse({ ...bindingFields, revision: 2 }).revision,
  ).toBe(2);
});

import { McpRecoverySchema } from "@tila/schemas";
import { TilaApiError } from "tila-sdk";
import { describe, expect, it } from "vitest";
import { toMcpError } from "../errors";
import { recoveryFor } from "../tool-registration";

/** A correction of someone else's report is refused with a 403 authority decision. */
const denied = () =>
  new TilaApiError(
    403,
    "report-correction-denied",
    "Only the original reporter or a project maintainer or owner can correct a report",
    false,
  );

describe("recoveryFor report-correction-denied", () => {
  it("names the authority rule instead of advising re-authentication", () => {
    const recovery = recoveryFor(denied());

    expect(recovery).toMatchObject({
      code: "report-correction-denied",
      retry_safety: "after_recovery",
    });
    expect(recovery.recovery_action).toMatch(/original reporter/);
    expect(recovery.recovery_action).toMatch(/new report without corrects_seq/);
    expect(recovery.recovery_action).toMatch(/nothing was recorded/);
    expect(recovery.recovery_action).not.toMatch(/Restore authentication/);
    expect(McpRecoverySchema.safeParse(recovery).success).toBe(true);
  });

  it("reads the same recovery through the MCP wrapper tools throw", () => {
    expect(recoveryFor(toMcpError(denied()))).toMatchObject({
      code: "report-correction-denied",
      retry_safety: "after_recovery",
    });
  });

  it("keeps ordinary permission denials on the re-authentication advice", () => {
    const recovery = recoveryFor(
      new TilaApiError(403, "permission-denied", "No access", false),
    );
    expect(recovery.recovery_action).toMatch(/Restore authentication/);
  });
});

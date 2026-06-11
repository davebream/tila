import { EntityNotFoundError, mapProjectError } from "@tila/ops-sqlite";
import { describe, expect, it } from "vitest";
import { NotFoundError } from "../src/errors";

describe("embedded/DO error parity", () => {
  it("uses the same not-found code for missing entities", () => {
    const doError = mapProjectError(new EntityNotFoundError("task-1"));
    const embeddedError = new NotFoundError("Entity task-1 not found");

    expect(doError?.code).toBe("not-found");
    expect(doError?.code).toBe(embeddedError.code);
  });
});

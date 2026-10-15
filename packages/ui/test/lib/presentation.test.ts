import { declaredStates, taskState } from "@/lib/presentation";
import type { WorkCatalogEntry } from "@tila/schemas";

const entry = (
  definition: WorkCatalogEntry["definition"],
  declaration: WorkCatalogEntry["declaration"] = "declared",
): WorkCatalogEntry => ({
  type: "t",
  declaration,
  count: 0,
  archived_count: 0,
  definition,
});

describe("declaredStates", () => {
  test("a lifecycle names its states and the values its field allows", () => {
    const states = declaredStates(
      entry({
        fields: [
          {
            name: "phase",
            type: "enum",
            required: true,
            values: ["todo", "doing", "done", "dropped", "parked"],
          },
          // Not the lifecycle field: its values are not states.
          { name: "status", type: "enum", required: false, values: ["x"] },
        ],
        lifecycle: {
          field: "phase",
          dispatchable: ["todo"],
          terminal: ["done", "dropped"],
          dependency_satisfied: ["done"],
          on_start: "doing",
          outcomes: { success: "done", cancelled: "dropped" },
        },
      }),
    );
    expect(states.slice().sort()).toEqual([
      "doing",
      "done",
      "dropped",
      "parked",
      "todo",
    ]);
  });

  test("a lifecycle over a free-form field still names its declared states", () => {
    expect(
      declaredStates(
        entry({
          fields: [{ name: "stage", type: "string", required: false }],
          lifecycle: {
            field: "stage",
            dispatchable: ["todo"],
            terminal: ["done"],
            dependency_satisfied: ["done"],
          },
        }),
      ).sort(),
    ).toEqual(["done", "todo"]);
  });

  test("a type without a lifecycle offers its status values", () => {
    expect(
      declaredStates(
        entry({
          fields: [
            {
              name: "status",
              type: "enum",
              required: false,
              values: ["draft", "published"],
            },
          ],
        }),
      ),
    ).toEqual(["draft", "published"]);
    expect(declaredStates(entry({ fields: [] }))).toEqual([]);
  });

  test("an undeclared type or a missing entry names none", () => {
    expect(declaredStates(entry(undefined, "undeclared"))).toEqual([]);
    expect(declaredStates(undefined)).toEqual([]);
  });

  test("agrees with the State column: only the lifecycle field counts", () => {
    const definition: NonNullable<WorkCatalogEntry["definition"]> = {
      fields: [{ name: "phase", type: "string", required: false }],
      lifecycle: {
        field: "phase",
        dispatchable: ["todo"],
        terminal: ["done"],
        dependency_satisfied: ["done"],
      },
    };
    expect(
      taskState({ phase: "todo", status: "done" }, entry(definition)),
    ).toMatchObject({
      value: "todo",
    });
    // The same data under a type with no lifecycle reads `status`.
    expect(
      taskState({ phase: "todo", status: "done" }, entry({ fields: [] })),
    ).toMatchObject({ value: "done" });
  });
});

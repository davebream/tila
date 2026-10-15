import {
  PolicyFields,
  PolicyForm,
  formToPolicy,
  policySummary,
  policyToForm,
  presetForm,
  recordAccess,
} from "@/components/settings/policy-fields";
import userEvent from "@testing-library/user-event";
import {
  CREDENTIAL_PRESETS,
  type CredentialPolicy,
  CredentialPolicySchema,
  type NamespaceRestrictions,
} from "@tila/schemas";
import { useState } from "react";
import { renderWithProviders, screen } from "../test-utils";

const policy = (restrictions?: NamespaceRestrictions): CredentialPolicy => ({
  role: "participant",
  capabilities: ["records:read", "records:write", "claims:acquire"],
  ...(restrictions === undefined ? {} : { restrictions }),
});

const saved = (form: PolicyForm) => {
  const built = formToPolicy(form);
  if (built.problem !== null) throw new Error(built.problem);
  return built.policy;
};

/** What a browser draft does to a form: stored as JSON and parsed back. */
const asDraft = (form: PolicyForm) =>
  PolicyForm.parse(JSON.parse(JSON.stringify(form)));

const LEGACY: NamespaceRestrictions[] = [
  { records: [{ type: "config" }] },
  { records: [{ type: "config", key_prefixes: ["team/a"] }, { type: "flag" }] },
  // Explicit denies: neither may come back as "no limit".
  { records: [] },
  { records: [{ type: "config", key_prefixes: [] }] },
  { records: [{ type: "a", key_prefixes: [] }, { type: "b" }] },
  { task_types: ["bug"], records: [] },
  // The list form cannot show two rules for one type or an order, but a
  // policy that has them must come back as it was.
  {
    records: [
      { type: "a", key_prefixes: ["x"] },
      { type: "a", key_prefixes: ["y"] },
    ],
  },
  { task_types: [] },
  { task_types: [], records: [{ type: "config" }] },
  { task_types: ["bug"] },
];

const SPLIT: NamespaceRestrictions[] = [
  { records_read: [{ type: "answer", key_prefixes: ["a1"] }] },
  { records_write: [{ type: "question", key_prefixes: ["q1", "q2/x"] }] },
  {
    records_read: [{ type: "answer", key_prefixes: ["a1"] }],
    records_write: [{ type: "question" }],
  },
  { records_read: [], records_write: [{ type: "question" }] },
  { records_read: [{ type: "answer", key_prefixes: [] }], records_write: [] },
  { records_read: [] },
  { records_write: [] },
  { records_read: [], records_write: [] },
  {
    task_types: ["bug"],
    records_read: [{ type: "answer" }],
    records_write: [{ type: "question", key_prefixes: ["q1"] }],
  },
];

describe("an untouched policy is saved exactly as it was opened", () => {
  it.each([...LEGACY, ...SPLIT])("%j", (restrictions) => {
    const original = policy(restrictions);
    expect(CredentialPolicySchema.safeParse(original).success).toBe(true);
    const form = policyToForm(original);
    expect(PolicyForm.safeParse(form).success).toBe(true);
    expect(saved(form)).toStrictEqual(original);
    // ...and still so after the form was kept as a browser draft.
    expect(saved(asDraft(form))).toStrictEqual(original);
  });

  it("keeps a policy without restrictions unrestricted", () => {
    const original = policy();
    expect(saved(policyToForm(original))).toStrictEqual(original);
    expect(saved(presetForm("worker")).restrictions).toBeUndefined();
  });

  it("is not changed by a role or capability edit", () => {
    for (const restrictions of [...LEGACY, ...SPLIT]) {
      const form = policyToForm(policy(restrictions));
      const out = saved({
        ...form,
        preset: "custom",
        role: "maintainer",
        capabilities: ["records:read"],
      });
      expect(out.restrictions).toStrictEqual(restrictions);
    }
  });

  it("never turns a stored deny into no limit by clearing and retyping", () => {
    // Text that is back to what was stored is the stored list again.
    const form = policyToForm(policy({ records: [] }));
    expect(form.records).toBe("");
    expect(saved({ ...form, records: "" }).restrictions).toStrictEqual({
      records: [],
    });
  });
});

describe("editing one side keeps the other as it was stored", () => {
  const both: NamespaceRestrictions = {
    records_read: [{ type: "answer", key_prefixes: ["a1"] }],
    records_write: [{ type: "question", key_prefixes: ["q1"] }],
  };

  it("keeps the read side when only the write list is edited", () => {
    const form = policyToForm(policy(both));
    expect(
      saved({ ...form, records_write: "question/q1\nquestion/q2" })
        .restrictions,
    ).toStrictEqual({
      records_read: both.records_read,
      records_write: [{ type: "question", key_prefixes: ["q1", "q2"] }],
    });
  });

  it("keeps the write side when only the read list is edited", () => {
    const form = policyToForm(policy(both));
    expect(
      saved({ ...form, records_read: "answer" }).restrictions,
    ).toStrictEqual({
      records_read: [{ type: "answer" }],
      records_write: both.records_write,
    });
  });

  it("keeps a side that was left out out, so it still denies", () => {
    const form = policyToForm(
      policy({ records_write: [{ type: "question" }] }),
    );
    const out = saved({ ...form, records_write: "question/q9" }).restrictions;
    expect(out).toStrictEqual({
      records_write: [{ type: "question", key_prefixes: ["q9"] }],
    });
    expect(out).not.toHaveProperty("records_read");
    expect(out).not.toHaveProperty("records");
  });

  it("keeps an explicit empty side explicit", () => {
    const form = policyToForm(
      policy({ records_read: [], records_write: [{ type: "q" }] }),
    );
    expect(saved({ ...form, records_write: "q/x" }).restrictions).toStrictEqual(
      { records_read: [], records_write: [{ type: "q", key_prefixes: ["x"] }] },
    );
  });

  it("writes an emptied side as an explicit deny, never as no limit", () => {
    const form = policyToForm(policy(both));
    expect(saved({ ...form, records_read: "" }).restrictions).toStrictEqual({
      records_read: [],
      records_write: both.records_write,
    });
  });

  it("never leaves both sides out: neither list given is two explicit denies", () => {
    const fresh = {
      ...presetForm("worker"),
      records_mode: "separate" as const,
      records_read: "",
      records_write: "",
    };
    expect(saved(fresh).restrictions).toStrictEqual({
      records_read: [],
      records_write: [],
    });
    // A stored one-sided policy whose only side was cleared stays restricted.
    const oneSided = policyToForm(
      policy({ records_write: [{ type: "question" }] }),
    );
    expect(
      saved({ ...oneSided, records_write: "" }).restrictions,
    ).toStrictEqual({ records_write: [] });
  });
});

describe("authoring record limits", () => {
  const worker = presetForm("worker");

  it("writes one list as `records`, and an empty one as a deny", () => {
    expect(
      saved({ ...worker, records_mode: "same", records: "config\nflag/x" })
        .restrictions,
    ).toStrictEqual({
      records: [{ type: "config" }, { type: "flag", key_prefixes: ["x"] }],
    });
    expect(
      saved({ ...worker, records_mode: "same", records: "" }).restrictions,
    ).toStrictEqual({ records: [] });
  });

  it("writes no record limit only for the `all` mode", () => {
    expect(
      saved({ ...worker, records_mode: "all", records: "config" }).restrictions,
    ).toBeUndefined();
  });

  it("writes a read-only and a write-only list with distinct rules", () => {
    const out = saved({
      ...worker,
      records_mode: "separate",
      records_read: "answer/a1",
      records_write: "question/q1",
    });
    expect(out.restrictions).toStrictEqual({
      records_read: [{ type: "answer", key_prefixes: ["a1"] }],
      records_write: [{ type: "question", key_prefixes: ["q1"] }],
    });
    // The saved policy is a valid one under the server's schema.
    expect(CredentialPolicySchema.safeParse(out).success).toBe(true);
  });

  it("merges prefixes per type and lets a whole type absorb them", () => {
    expect(
      saved({
        ...worker,
        records_mode: "same",
        records: "a/x\nb\na/y\nb/z\nc (no keys)",
      }).restrictions,
    ).toStrictEqual({
      records: [
        { type: "a", key_prefixes: ["x", "y"] },
        { type: "b" },
        { type: "c", key_prefixes: [] },
      ],
    });
  });

  it("keeps task types and records limits independent", () => {
    expect(
      saved({
        ...worker,
        task_types: "bug",
        records_mode: "same",
        records: "config",
      }).restrictions,
    ).toStrictEqual({ task_types: ["bug"], records: [{ type: "config" }] });
  });
});

describe("malformed record rules", () => {
  const worker = presetForm("worker");
  const problem = (change: Partial<PolicyForm>) => {
    const built = formToPolicy({ ...worker, ...change });
    return built.problem;
  };

  it("names the list, the line and the reason for a bad type", () => {
    expect(
      problem({
        records_mode: "separate",
        records_read: "answer\nAnswer/a1",
        records_write: "",
      }),
    ).toMatch(
      /^Records it may read, line 2 \(Answer\/a1\): Record type must start with lowercase/,
    );
  });

  it("refuses an empty key prefix instead of widening it to the whole type", () => {
    expect(problem({ records_mode: "same", records: "config/" })).toMatch(
      /^Limit to records, line 1 \(config\/\): .*empty.*Write "config"/,
    );
  });

  it("refuses an invalid key prefix with the schema's reason", () => {
    expect(
      problem({
        records_mode: "separate",
        records_read: "",
        records_write: "question/a//b",
      }),
    ).toMatch(
      /^Records it may write, line 1 \(question\/a\/\/b\): .*empty segments/,
    );
  });

  it("counts blank lines so the line can be found", () => {
    expect(
      problem({ records_mode: "same", records: "config\n\n\nBad" }),
    ).toMatch(/line 4 \(Bad\)/);
  });

  it("reports a list that is too long under its own name", () => {
    const many = Array.from({ length: 101 }, (_, i) => `t${i}`).join("\n");
    expect(
      problem({
        records_mode: "separate",
        records_read: many,
        records_write: "",
      }),
    ).toMatch(/^Records it may read: /);
  });

  it("returns no policy while a rule is malformed", () => {
    const built = formToPolicy({
      ...worker,
      records_mode: "same",
      records: "Nope",
    });
    expect("policy" in built).toBe(false);
  });
});

describe("drafts from earlier forms still open", () => {
  it("opens a draft saved before the split fields existed", () => {
    const { records_split: _s, ...older } = policyToForm(policy());
    expect(PolicyForm.safeParse(older).success).toBe(true);
    const bare = {
      preset: "custom",
      role: "participant" as const,
      capabilities: ["records:read"],
      task_types: "",
      records: "",
    };
    expect(saved(bare).restrictions).toBeUndefined();
    expect(saved({ ...bare, records: "config" }).restrictions).toStrictEqual({
      records: [{ type: "config" }],
    });
  });

  it("opens a draft that carried split rules display-only, unchanged", () => {
    const split: NamespaceRestrictions = {
      records_read: [{ type: "answer", key_prefixes: [] }],
      records_write: [],
    };
    const carried = {
      preset: "custom",
      role: "participant" as const,
      capabilities: ["records:read", "records:write"],
      task_types: "",
      records: "",
      records_split: split,
    };
    expect(PolicyForm.safeParse(carried).success).toBe(true);
    expect(saved(carried).restrictions).toStrictEqual(split);
  });

  it("still refuses a record list next to carried split rules", () => {
    const built = formToPolicy({
      preset: "custom",
      role: "participant",
      capabilities: ["records:read"],
      task_types: "",
      records: "answer",
      records_split: { records_read: [{ type: "answer" }], records_write: [] },
    });
    expect(built.problem).toMatch(/limits record reads and writes separately/);
    expect("policy" in built).toBe(false);
  });
});

describe("the summary states both effective sides", () => {
  const sides = (restrictions?: NamespaceRestrictions) =>
    recordAccess(policy(restrictions));

  it("says every record when nothing limits records", () => {
    expect(sides()).toEqual({ read: "every record", write: "every record" });
    expect(policySummary(policy())).not.toContain("records");
  });

  it("states a legacy list for both sides", () => {
    expect(policySummary(policy({ records: [{ type: "config" }] }))).toContain(
      "records read: config · records write: config",
    );
    expect(sides({ records: [] })).toEqual({ read: "none", write: "none" });
  });

  it("states split sides, with prefixes and a missing side as none", () => {
    expect(
      policySummary(
        policy({
          records_read: [{ type: "answer", key_prefixes: ["a1"] }],
          records_write: [{ type: "question", key_prefixes: ["q1", "q2/x"] }],
        }),
      ),
    ).toContain(
      "records read: answer/a1 · records write: question/q1, question/q2/x",
    );
    expect(
      policySummary(policy({ records_write: [{ type: "question" }] })),
    ).toContain("records read: none · records write: question");
    expect(
      policySummary(policy({ records_read: [], records_write: [] })),
    ).toContain("records read: none · records write: none");
  });

  it("does not claim a side the capabilities do not grant", () => {
    const readOnly: CredentialPolicy = {
      role: "viewer",
      capabilities: ["records:read", "records:write"],
      restrictions: {
        records_read: [{ type: "answer" }],
        records_write: [{ type: "question" }],
      },
    };
    // viewer is below the participant threshold of records:write
    expect(recordAccess(readOnly)).toEqual({
      read: "answer",
      write: "none (no records:write)",
    });
    expect(
      recordAccess({
        role: "participant",
        capabilities: ["records:write"],
        restrictions: { records: [{ type: "config" }] },
      }),
    ).toEqual({ read: "none (no records:read)", write: "config" });
  });

  it("states an empty prefix list as none", () => {
    expect(sides({ records: [{ type: "config", key_prefixes: [] }] })).toEqual({
      read: "none",
      write: "none",
    });
  });

  it("states an explicit empty task list", () => {
    expect(policySummary(policy({ task_types: [] }))).toContain("tasks: none");
  });
});

function Harness({ initial }: { initial: PolicyForm }) {
  const [form, setForm] = useState(initial);
  const built = formToPolicy(form);
  return (
    <div>
      <PolicyFields
        form={form}
        disabled={false}
        problem={built.problem ?? undefined}
        onChange={setForm}
      />
      <output aria-label="saved policy">
        {built.problem === null
          ? JSON.stringify(built.policy)
          : `problem: ${built.problem}`}
      </output>
    </div>
  );
}

const outcome = () =>
  JSON.parse(screen.getByLabelText("saved policy").textContent ?? "{}");
const effective = () =>
  screen.getByRole("status", { name: "Effective record access" }).textContent;
const modeSelect = () =>
  screen.getByRole("combobox", { name: /Record access/ });
const list = (name: RegExp) => screen.getByRole("textbox", { name });

describe("PolicyFields", () => {
  it("authors a read-only answer/a1 and a write-only question/q1", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness initial={presetForm("worker")} />);
    expect(modeSelect()).toHaveValue("all");
    expect(effective()).toBe("Reads: every record · Writes: every record");
    expect(
      screen.queryByRole("textbox", { name: /Limit to records/ }),
    ).not.toBeInTheDocument();

    await user.selectOptions(modeSelect(), "separate");
    // Nothing is granted by switching: both sides start empty and deny.
    expect(outcome().restrictions).toEqual({
      records_read: [],
      records_write: [],
    });
    expect(effective()).toBe("Reads: none · Writes: none");

    await user.type(list(/Records it may read/), "answer/a1");
    await user.type(list(/Records it may write/), "question/q1");
    expect(outcome().restrictions).toEqual({
      records_read: [{ type: "answer", key_prefixes: ["a1"] }],
      records_write: [{ type: "question", key_prefixes: ["q1"] }],
    });
    expect(effective()).toBe("Reads: answer/a1 · Writes: question/q1");
    expect(CredentialPolicySchema.safeParse(outcome()).success).toBe(true);
  });

  it("opens a split policy with both lists editable and their rules shown", () => {
    renderWithProviders(
      <Harness
        initial={policyToForm(
          policy({
            records_read: [{ type: "answer", key_prefixes: ["a1", "a2"] }],
            records_write: [{ type: "question" }],
          }),
        )}
      />,
    );
    expect(modeSelect()).toHaveValue("separate");
    expect(list(/Records it may read/)).toHaveValue("answer/a1\nanswer/a2");
    expect(list(/Records it may write/)).toHaveValue("question");
    expect(list(/Records it may read/)).toBeEnabled();
  });

  it("shows an empty prefix list as a line, not as a missing rule", () => {
    renderWithProviders(
      <Harness
        initial={policyToForm(
          policy({ records: [{ type: "config", key_prefixes: [] }] }),
        )}
      />,
    );
    expect(list(/Limit to records/)).toHaveValue("config (no keys)");
    expect(outcome().restrictions).toEqual({
      records: [{ type: "config", key_prefixes: [] }],
    });
  });

  it("keeps a stored deny while other fields are edited", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <Harness initial={policyToForm(policy({ records: [] }))} />,
    );
    expect(modeSelect()).toHaveValue("same");
    expect(effective()).toBe("Reads: none · Writes: none");
    await user.selectOptions(
      screen.getByRole("combobox", { name: /Preset/ }),
      "worker",
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: /Role ceiling/ }),
      "viewer",
    );
    expect(outcome().restrictions).toEqual({ records: [] });
  });

  it("carries the same list to both sides when records are limited separately", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <Harness
        initial={policyToForm(
          policy({ records: [{ type: "config", key_prefixes: ["team"] }] }),
        )}
      />,
    );
    await user.selectOptions(modeSelect(), "separate");
    expect(list(/Records it may read/)).toHaveValue("config/team");
    expect(list(/Records it may write/)).toHaveValue("config/team");
    expect(outcome().restrictions).toEqual({
      records_read: [{ type: "config", key_prefixes: ["team"] }],
      records_write: [{ type: "config", key_prefixes: ["team"] }],
    });
  });

  it("never combines the legacy list with split lists, and loses nothing", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <Harness
        initial={policyToForm(
          policy({
            records_read: [{ type: "answer" }],
            records_write: [{ type: "question" }],
          }),
        )}
      />,
    );
    // Switch to the single list: read and write differ, so it starts empty
    // (no records) rather than picking a side.
    await user.selectOptions(modeSelect(), "same");
    expect(list(/Limit to records/)).toHaveValue("");
    expect(outcome().restrictions).toEqual({ records: [] });
    await user.type(list(/Limit to records/), "config");
    expect(outcome().restrictions).toEqual({ records: [{ type: "config" }] });

    // Back to separate: each side is exactly what it was.
    await user.selectOptions(modeSelect(), "separate");
    expect(list(/Records it may read/)).toHaveValue("answer");
    expect(list(/Records it may write/)).toHaveValue("question");
    expect(outcome().restrictions).toEqual({
      records_read: [{ type: "answer" }],
      records_write: [{ type: "question" }],
    });
    expect(outcome().restrictions).not.toHaveProperty("records");
  });

  it("makes the removal of every limit an explicit choice", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <Harness
        initial={policyToForm(
          policy({ records_write: [{ type: "question" }] }),
        )}
      />,
    );
    expect(effective()).toBe("Reads: none · Writes: question");
    await user.selectOptions(modeSelect(), "all");
    expect(outcome()).toEqual({
      role: "participant",
      capabilities: ["records:read", "records:write", "claims:acquire"],
    });
    expect(effective()).toBe("Reads: every record · Writes: every record");
    // And the limits are still there when the choice is taken back.
    await user.selectOptions(modeSelect(), "separate");
    expect(outcome().restrictions).toEqual({
      records_write: [{ type: "question" }],
    });
  });

  it("keeps the limits across a preset change", async () => {
    const user = userEvent.setup();
    const restrictions: NamespaceRestrictions = {
      records_read: [{ type: "answer", key_prefixes: ["a1"] }],
      records_write: [{ type: "question", key_prefixes: ["q1"] }],
    };
    renderWithProviders(
      <Harness initial={policyToForm(policy(restrictions))} />,
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: /Preset/ }),
      "worker",
    );
    expect(outcome()).toEqual({
      role: "participant",
      capabilities: CREDENTIAL_PRESETS.worker.capabilities,
      restrictions,
    });
  });

  it("keeps the limits when task types are edited", async () => {
    const user = userEvent.setup();
    const restrictions: NamespaceRestrictions = {
      records_read: [{ type: "answer" }],
      records_write: [{ type: "question" }],
    };
    renderWithProviders(
      <Harness initial={policyToForm(policy(restrictions))} />,
    );
    await user.type(
      screen.getByRole("textbox", { name: /Limit to task types/ }),
      "bug",
    );
    expect(outcome().restrictions).toEqual({
      task_types: ["bug"],
      ...restrictions,
    });
  });

  it("explains a stored policy that allows no task type", () => {
    renderWithProviders(
      <Harness initial={policyToForm(policy({ task_types: [] }))} />,
    );
    expect(
      screen.getByText(/This policy allows no task types/),
    ).toBeInTheDocument();
    expect(outcome().restrictions).toEqual({ task_types: [] });
  });

  it("shows an actionable error and no policy for a malformed rule", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness initial={presetForm("worker")} />);
    await user.selectOptions(modeSelect(), "same");
    await user.type(list(/Limit to records/), "Config");
    expect(screen.getByRole("alert")).toHaveTextContent(
      /Limit to records, line 1 \(Config\): Record type must start with lowercase/,
    );
    expect(screen.getByLabelText("saved policy")).toHaveTextContent(
      /^problem:/,
    );
    // No effective summary is claimed for a policy that cannot be saved.
    expect(
      screen.queryByRole("status", { name: "Effective record access" }),
    ).not.toBeInTheDocument();
  });

  it("states a side the capabilities do not grant as none", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness initial={presetForm("read-only")} />);
    await user.selectOptions(modeSelect(), "separate");
    await user.type(list(/Records it may write/), "question");
    expect(effective()).toBe("Reads: none · Writes: none (no records:write)");
  });
});

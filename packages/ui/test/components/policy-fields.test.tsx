import {
  PolicyFields,
  PolicyForm,
  formToPolicy,
  policySummary,
  policyToForm,
} from "@/components/settings/policy-fields";
import userEvent from "@testing-library/user-event";
import {
  CREDENTIAL_PRESETS,
  type CredentialPolicy,
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

const SPLIT: NamespaceRestrictions[] = [
  { records_read: [{ type: "answer", key_prefixes: ["a1"] }] },
  { records_write: [{ type: "question", key_prefixes: ["q1", "q2/x"] }] },
  {
    records_read: [{ type: "answer", key_prefixes: ["a1"] }],
    records_write: [{ type: "question" }],
  },
  { records_read: [], records_write: [{ type: "question" }] },
  { records_read: [{ type: "answer", key_prefixes: [] }], records_write: [] },
  {
    task_types: ["bug"],
    records_read: [{ type: "answer" }],
    records_write: [{ type: "question", key_prefixes: ["q1"] }],
  },
];

describe("a policy that limits record reads and writes separately", () => {
  it.each(SPLIT)("is saved exactly as it was opened: %j", (restrictions) => {
    const original = policy(restrictions);
    const form = policyToForm(original);
    expect(PolicyForm.safeParse(form).success).toBe(true);
    // Nothing is shown as an editable record list that would be written back.
    expect(form.records).toBe("");
    expect(saved(form)).toEqual(original);
  });

  it("never serializes as unrestricted, whatever else is edited", () => {
    for (const restrictions of SPLIT) {
      const form = policyToForm(policy(restrictions));
      const edited = {
        ...form,
        preset: "custom",
        role: "maintainer" as const,
        capabilities: ["records:read"],
        task_types: "",
      };
      const out = saved(edited);
      expect(out.restrictions?.records_read).toEqual(restrictions.records_read);
      expect(out.restrictions?.records_write).toEqual(
        restrictions.records_write,
      );
      expect(out.restrictions).not.toBeUndefined();
      expect(out.restrictions?.records).toBeUndefined();
    }
  });

  it("keeps a side that was left out out: the missing side stays denied", () => {
    const out = saved(
      policyToForm(policy({ records_write: [{ type: "question" }] })),
    );
    expect(out.restrictions).toEqual({ records_write: [{ type: "question" }] });
    expect(out.restrictions).not.toHaveProperty("records_read");
    expect(out.restrictions).not.toHaveProperty("records");
  });

  it("refuses a record list next to it instead of merging the two forms", () => {
    const form = policyToForm(
      policy({ records_read: [{ type: "answer" }], records_write: [] }),
    );
    const built = formToPolicy({ ...form, records: "answer" });
    expect(built.problem).toMatch(/limits record reads and writes separately/);
    expect("policy" in built).toBe(false);
  });

  it("is summarized by side, with a missing side as none", () => {
    expect(
      policySummary(
        policy({
          records_read: [{ type: "answer" }],
          records_write: [{ type: "question" }],
        }),
      ),
    ).toContain("records read: answer · records write: question");
    expect(
      policySummary(policy({ records_write: [{ type: "question" }] })),
    ).toContain("records read: none · records write: question");
    expect(
      policySummary(policy({ records_read: [], records_write: [] })),
    ).toContain("records read: none · records write: none");
  });

  it("still opens a draft saved before the split fields existed", () => {
    const { records_split: _omitted, ...older } = policyToForm(policy());
    expect(PolicyForm.safeParse(older).success).toBe(true);
  });
});

describe("a policy with a single record list is unchanged", () => {
  it("round-trips as before", () => {
    const original = policy({
      task_types: ["bug"],
      records: [{ type: "config", key_prefixes: ["team/a"] }, { type: "flag" }],
    });
    const form = policyToForm(original);
    expect(form.records).toBe("config/team/a\nflag");
    expect(form).not.toHaveProperty("records_split");
    expect(saved(form)).toEqual(original);
  });

  it("an edited list is still written as `records`", () => {
    const form = policyToForm(policy({ records: [{ type: "config" }] }));
    const out = saved({ ...form, records: "config\nflag/x" });
    expect(out.restrictions).toEqual({
      records: [{ type: "config" }, { type: "flag", key_prefixes: ["x"] }],
    });
  });
});

function Harness({ initial }: { initial: PolicyForm }) {
  const [form, setForm] = useState(initial);
  const built = formToPolicy(form);
  return (
    <div>
      <PolicyFields form={form} disabled={false} onChange={setForm} />
      <output aria-label="saved policy">
        {built.problem === null
          ? JSON.stringify(built.policy)
          : `problem: ${built.problem}`}
      </output>
    </div>
  );
}

describe("PolicyFields with a split policy", () => {
  const restrictions: NamespaceRestrictions = {
    records_read: [{ type: "answer", key_prefixes: ["a1"] }],
    records_write: [{ type: "question", key_prefixes: ["q1"] }],
  };
  const outcome = () =>
    JSON.parse(screen.getByLabelText("saved policy").textContent ?? "{}");

  it("shows both sides read-only and keeps them across a preset change", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <Harness initial={policyToForm(policy(restrictions))} />,
    );
    const records = screen.getByRole("textbox", { name: /Limit to records/ });
    expect(records).toBeDisabled();
    expect(records).toHaveValue("read: answer/a1\nwrite: question/q1");

    // Switching the preset replaces the role and capabilities, not the limits.
    await user.selectOptions(
      screen.getByRole("combobox", { name: /Preset/ }),
      "worker",
    );
    expect(outcome()).toEqual({
      role: "participant",
      capabilities: CREDENTIAL_PRESETS.worker.capabilities,
      restrictions,
    });

    await user.selectOptions(
      screen.getByRole("combobox", { name: /Role ceiling/ }),
      "viewer",
    );
    expect(outcome().restrictions).toEqual(restrictions);
  });

  it("keeps the limits when task types are edited", async () => {
    const user = userEvent.setup();
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

  it("leaves a legacy list editable", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <Harness
        initial={policyToForm(policy({ records: [{ type: "config" }] }))}
      />,
    );
    const records = screen.getByRole("textbox", { name: /Limit to records/ });
    expect(records).toBeEnabled();
    await user.type(records, "\nflag");
    expect(outcome().restrictions).toEqual({
      records: [{ type: "config" }, { type: "flag" }],
    });
  });
});

describe("an untouched policy keeps its explicit empty limits", () => {
  const STORED: NamespaceRestrictions[] = [
    // Each of these denies; none may come back as "no limit".
    { records: [] },
    { records: [{ type: "config", key_prefixes: [] }] },
    { records: [{ type: "a", key_prefixes: [] }, { type: "b" }] },
    { task_types: [] },
    { task_types: [], records: [{ type: "config" }] },
    { task_types: ["bug"], records: [] },
    // Two rules for one type: the lines cannot say which rule held what.
    {
      records: [
        { type: "a", key_prefixes: ["x"] },
        { type: "a", key_prefixes: ["y"] },
      ],
    },
  ];

  it.each(STORED)("is saved as it was opened: %j", (restrictions) => {
    const original = policy(restrictions);
    const form = policyToForm(original);
    expect(PolicyForm.safeParse(form).success).toBe(true);
    expect(saved(form)).toStrictEqual(original);
    // ...also after the form was kept as a browser draft.
    expect(
      saved(PolicyForm.parse(JSON.parse(JSON.stringify(form)))),
    ).toStrictEqual(original);
  });

  it("is not changed by a role or capability edit", () => {
    for (const restrictions of STORED) {
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

  it("still lets an edited list replace the stored one", () => {
    const form = policyToForm(policy({ records: [], task_types: [] }));
    const out = saved({ ...form, records: "config", task_types: "bug" });
    expect(out.restrictions).toStrictEqual({
      task_types: ["bug"],
      records: [{ type: "config" }],
    });
  });
});

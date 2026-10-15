// Independent ascending oracle; never populated from acknowledgements or pages.
export const scaleExpectedIds = Object.freeze(
  Array.from(
    { length: 301 },
    (_, i) => `s1-scale-${String(i + 1).padStart(3, "0")}`,
  ),
);

export const scaleDefinition = `schema_version = 1

[work_units.task]
fields = [{ name = "title", type = "string", required = true }]

[work_units.bug]
fields = []
`;

// A permutation, deliberately unrelated to the required traversal order.
// Every title has two tokens and one occurrence of the common search term.
export const scaleCreates = Object.freeze(
  Array.from({ length: 301 }, (_, k) => {
    const n = ((37 * k) % 301) + 1;
    const suffix = String(n).padStart(3, "0");
    return Object.freeze({
      id: `s1-scale-${suffix}`,
      type: "task",
      data: Object.freeze({
        title: `s1scalecommon ${n === 301 ? "s1scalesentinel" : `s1scalerow${suffix}`}`,
      }),
    });
  }),
);

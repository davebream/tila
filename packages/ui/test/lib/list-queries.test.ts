import {
  decisionViewFromSearch,
  questionQueryFromSearch,
} from "@/lib/list-queries";

const search = (value: string) => new URLSearchParams(value);
const ME = "github:example:1";

describe("questionQueryFromSearch", () => {
  test("the default view is the open questions routed to the caller", () => {
    expect(questionQueryFromSearch(search(""), ME)).toEqual({
      state: "open",
      responder_principal_id: ME,
    });
    expect(questionQueryFromSearch(search("?view=bogus"), ME)).toEqual({
      state: "open",
      responder_principal_id: ME,
    });
  });

  test("nothing can wait on a caller without a principal", () => {
    expect(questionQueryFromSearch(search(""), undefined)).toBeNull();
    expect(questionQueryFromSearch(search("?view=open"), undefined)).toEqual({
      state: "open",
    });
  });

  test("other views filter by state for everyone, and escalated narrows any view", () => {
    expect(
      questionQueryFromSearch(search("?view=answered&escalated=1"), ME),
    ).toEqual({ state: "answered", escalated: true });
    expect(questionQueryFromSearch(search("?escalated=1"), ME)).toEqual({
      state: "open",
      responder_principal_id: ME,
      escalated: true,
    });
    expect(
      questionQueryFromSearch(search("?escalated=0"), ME),
    ).not.toHaveProperty("escalated");
  });

  test("views fall back to waiting on me", () => {
    expect(decisionViewFromSearch(search("?view=superseded"))).toBe(
      "superseded",
    );
    expect(decisionViewFromSearch(search("?view=MINE"))).toBe("mine");
  });
});

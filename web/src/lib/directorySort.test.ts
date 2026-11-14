import { describe, expect, it } from "vitest";
import type { CustomField } from "./api/types";
import { companyFilter, isFiltered, parseCompanySearch, parsePeopleSearch, peopleFilter, toggleFieldFilter } from "./directorySort";

const field = (key: string, type: CustomField["type"]): CustomField => ({
  id: key,
  entity: "contact",
  key,
  name: key,
  type,
  options: [],
  required_on_solve: false,
  description: "",
  position: 0,
  archived: false,
  created_at: "",
  updated_at: "",
});

describe("People and Companies search parameters", () => {
  it("keeps what the address may hold and drops the rest", () => {
    expect(parsePeopleSearch({ q: "ann", company: "none", blocked: "maybe", sort: "drop", fields: "plan:any:a,b|bad" })).toEqual({
      q: "ann",
      company: "none",
      tag: undefined,
      blocked: undefined,
      sort: undefined,
      fields: "plan:any:a,b",
    });
    expect(parseCompanySearch({ sort: "-updated", tag: "" })).toEqual({ q: undefined, tag: undefined, sort: "-updated", fields: undefined });
  });

  it("turns the address into the API's filters, the same for the list and for everyone who matches", () => {
    expect(peopleFilter({ q: "ann", company: "c1", fields: "plan:any:a|vip:eq:true", sort: "name" })).toEqual({
      q: "ann",
      company_id: "c1",
      tag: undefined,
      blocked: undefined,
      fields: [
        { key: "plan", op: "any", value: "a" },
        { key: "vip", op: "eq", value: "true" },
      ],
    });
    expect(companyFilter({ tag: "x" })).toEqual({ q: undefined, tag: "x", fields: undefined });
    expect(isFiltered({ sort: "name" })).toBe(false);
    expect(isFiltered({ fields: "a:set:" })).toBe(true);
    expect(isFiltered({ company: "none" })).toBe(true);
  });

  it("toggles a field filter's values by the field's type", () => {
    const plan = field("plan", "select");
    let f = toggleFieldFilter([], plan, "a");
    f = toggleFieldFilter(f, plan, "b");
    expect(f).toEqual([{ key: "plan", op: "any", value: "a,b" }]);
    f = toggleFieldFilter(f, plan, "a");
    expect(f).toEqual([{ key: "plan", op: "any", value: "b" }]);
    expect(toggleFieldFilter(f, plan, "b")).toEqual([]);

    const vip = field("vip", "checkbox");
    expect(toggleFieldFilter([], vip, "false")).toEqual([{ key: "vip", op: "eq", value: "false" }]);
    expect(toggleFieldFilter([{ key: "vip", op: "eq", value: "false" }], vip, "true")).toEqual([{ key: "vip", op: "eq", value: "true" }]);

    // Other fields filter on whether they have a value, one or the other.
    const tz = field("tz", "text");
    expect(toggleFieldFilter([], tz, "set")).toEqual([{ key: "tz", op: "set", value: "" }]);
    expect(toggleFieldFilter([{ key: "tz", op: "set", value: "" }], tz, "not_set")).toEqual([{ key: "tz", op: "not_set", value: "" }]);
    expect(toggleFieldFilter([{ key: "tz", op: "set", value: "" }], tz, "set")).toEqual([]);
  });
});

// The People and Companies lists' search parameters (contracts/api.md "Contacts"): how they can
// be ordered, first the default, and the filters they hold, as the page's address keeps them and
// as the API takes them, for the list and for "everyone who matches" in a bulk action.
import type { CompanyBulkQuery, CompanySort, ContactBulkQuery, ContactSort } from "./api/endpoints";
import type { CustomField, FieldFilter } from "./api/types";
import { encodeFieldFilters, parseFieldFilters } from "./folders";

export const PEOPLE_SORTS: ContactSort[] = ["-created", "created", "name", "-name", "-tickets", "tickets", "-updated", "updated"];
export const COMPANY_SORTS: CompanySort[] = ["name", "-name", "created", "-created", "contacts", "-contacts", "-updated", "updated"];

/** `company=none` lists the people without a company. */
export const NO_COMPANY = "none";

export type PeopleSearch = { q?: string; company?: string; tag?: string; blocked?: "true" | "false"; sort?: ContactSort; fields?: string };
export type CompanySearch = { q?: string; tag?: string; sort?: CompanySort; fields?: string };

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

export function parsePeopleSearch(s: Record<string, unknown>): PeopleSearch {
  return {
    q: str(s.q),
    company: str(s.company),
    tag: str(s.tag),
    blocked: s.blocked === "true" || s.blocked === "false" ? s.blocked : undefined,
    sort: PEOPLE_SORTS.find((v) => v === s.sort),
    fields: encodeFieldFilters(parseFieldFilters(str(s.fields))),
  };
}

export function parseCompanySearch(s: Record<string, unknown>): CompanySearch {
  return { q: str(s.q), tag: str(s.tag), sort: COMPANY_SORTS.find((v) => v === s.sort), fields: encodeFieldFilters(parseFieldFilters(str(s.fields))) };
}

/** The People list's filters as the API takes them, without the order. */
export function peopleFilter(s: PeopleSearch): ContactBulkQuery {
  const fields = parseFieldFilters(s.fields);
  return { q: s.q, company_id: s.company, tag: s.tag, blocked: s.blocked, fields: fields.length ? fields : undefined };
}

export function companyFilter(s: CompanySearch): CompanyBulkQuery {
  const fields = parseFieldFilters(s.fields);
  return { q: s.q, tag: s.tag, fields: fields.length ? fields : undefined };
}

/** Whether anything narrows the list (the order does not). */
export const isFiltered = (s: PeopleSearch | CompanySearch) => !!(s.q || s.tag || s.fields || ("company" in s && s.company) || ("blocked" in s && s.blocked));

/** Fields picked from a list of their values; the others filter on whether they have one. */
export const pickable = (f: CustomField) => f.type === "select" || f.type === "multi_select" || f.type === "user" || f.type === "checkbox";

/** The values a field's filter holds (option ids, user ids, "true"/"false"), or its op for the others. */
export function filterValues(filters: FieldFilter[], f: CustomField): string[] {
  const ff = filters.find((x) => x.key === f.key);
  if (!ff) return [];
  if (ff.op === "set" || ff.op === "not_set") return [ff.op];
  return ff.value.split(",").filter(Boolean);
}

/**
 * Turns one value of a field's filter on or off. A checkbox is yes or no, a list field matches
 * any of its ticked values, and any other field has a value or is empty ("set", "not_set").
 */
export function toggleFieldFilter(filters: FieldFilter[], f: CustomField, v: string): FieldFilter[] {
  const rest = filters.filter((x) => x.key !== f.key);
  const cur = filterValues(filters, f);
  if (!pickable(f)) return cur.includes(v) ? rest : [...rest, { key: f.key, op: v === "not_set" ? "not_set" : "set", value: "" }];
  if (f.type === "checkbox") return cur.includes(v) ? rest : [...rest, { key: f.key, op: "eq", value: v }];
  const next = cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v];
  return next.length ? [...rest, { key: f.key, op: "any", value: next.join(",") }] : rest;
}

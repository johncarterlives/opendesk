import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/i18n";
import { ConfirmProvider } from "@/components/ui/confirm";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useSession } from "@/lib/session";
import { qk } from "@/lib/queries";
import { installMock } from "@/mock";
import { db } from "@/mock/db";
import { evaluateRouting } from "@/mock/teams";
import RoutingRuleEdit from "./RoutingRuleEdit";
import Routing from "./Routing";

const routeState = vi.hoisted(() => ({ ruleId: "" }));
vi.mock("@/components/settings2/UnsavedGuard", () => ({ UnsavedGuard: () => null }));
vi.mock("@tanstack/react-router", async (load) => {
  const actual = await load<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({ to, children, ...props }: React.ComponentProps<"a"> & { to: string }) => <a href={to} {...props}>{children}</a>,
    useNavigate: () => vi.fn(),
    useParams: () => ({ ruleId: routeState.ruleId }),
  };
});

vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value() {} });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 30)));

describe("skill-based routing rule editor", () => {
  installMock();
  const ws = db.workspaces[0];
  let savedRules = ws.routingRules;
  let savedSkills = ws.skills;
  let root: Root;
  let el: HTMLDivElement;

  beforeEach(() => {
    savedRules = ws.routingRules;
    savedSkills = ws.skills;
    routeState.ruleId = ws.routingRules.find((rule) => rule.enabled)!.id;
    el = document.createElement("div");
    document.body.appendChild(el);
    root = createRoot(el);
    useSession.setState({ status: "authed", workspaceId: ws.workspace.id, memberships: [{ workspace: ws.workspace, role: "admin" }] } as never);
  });
  afterEach(() => {
    ws.routingRules = savedRules;
    ws.skills = savedSkills;
    act(() => root.unmount());
    el.remove();
  });

  let qc: QueryClient;
  const mount = async () => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    await act(async () => root.render(<QueryClientProvider client={qc}><TooltipProvider><ConfirmProvider><RoutingRuleEdit /></ConfirmProvider></TooltipProvider></QueryClientProvider>));
    for (let i = 0; i < 100 && (!el.querySelector("#rule-name") || !qc.getQueryData(qk.skills)); i++) await settle();
    await settle();
  };

  it("selects active skills and saves them on the rule", async () => {
    const rule = ws.routingRules.find((item) => item.id === routeState.ruleId)!;
    const original = rule.skill_ids;
    rule.skill_ids = [];
    const skill = ws.skills.find((item) => item.name === "Security")!;
    await mount();
    const picker = [...el.querySelectorAll("button")].find((button) => button.textContent?.includes("Choose skills"));
    expect(picker).toBeDefined();
    await act(async () => picker!.click());
    await settle();
    const option = [...document.querySelectorAll("[cmdk-item]")].find((item) => item.textContent?.includes(skill.name));
    expect(option).toBeDefined();
    await act(async () => (option as HTMLElement).click());
    await settle();
    expect(el.textContent).toContain(skill.name);
    const save = [...el.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Save changes");
    expect(save).toBeDefined();
    await act(async () => save!.click());
    for (let i = 0; i < 30 && !rule.skill_ids.includes(skill.id); i++) await settle();
    expect(rule.skill_ids).toContain(skill.id);
    rule.skill_ids = original;
  });

  it("clears a skill selection in the editor", async () => {
    const rule = ws.routingRules.find((item) => item.id === routeState.ruleId)!;
    const original = [...rule.skill_ids];
    const skill = ws.skills.find((item) => item.name === "Billing")!;
    rule.skill_ids = [];
    await mount();
    const trigger = [...el.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Choose skills");
    expect(trigger).toBeDefined();
    await act(async () => trigger!.click());
    await settle();
    const option = [...document.querySelectorAll("[cmdk-item]")].find((item) => item.textContent?.includes(skill.name));
    expect(option).toBeDefined();
    await act(async () => (option as HTMLElement).click());
    await settle();
    expect([...el.querySelectorAll("button")].some((button) => button.textContent?.trim() === skill.name)).toBe(true);
    const selectedOption = [...document.querySelectorAll("[cmdk-item]")].find((item) => item.textContent?.includes(skill.name));
    expect(selectedOption).toBeDefined();
    await act(async () => (selectedOption as HTMLElement).click());
    await settle();
    expect([...el.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Choose skills")).toBe(true);
    rule.skill_ids = original;
  });

  it("omits an archived skill when an unrelated edit saves the rule", async () => {
    const rule = ws.routingRules.find((item) => item.id === routeState.ruleId)!;
    const active = ws.skills[0];
    const archived = { id: "archived-skill-test", name: "Archived expertise", archived: true, member_ids: [] };
    ws.skills = [...ws.skills, archived];
    rule.skill_ids = [...rule.skill_ids.filter((id) => id !== archived.id), archived.id];
    await mount();
    expect(el.textContent).not.toContain(archived.name);
    expect(el.textContent).toContain(active.name);
    const name = el.querySelector<HTMLInputElement>("#rule-name")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(name, `${rule.name} edited`);
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();
    const save = [...el.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Save changes");
    expect(save).toBeDefined();
    await act(async () => save!.click());
    for (let i = 0; i < 30 && !rule.name.endsWith("edited"); i++) await settle();
    expect(rule.name).toContain("edited");
    expect(rule.skill_ids).not.toContain(archived.id);
  });

  it("shows required skill labels returned by the routing test panel", async () => {
    const rule = ws.routingRules.find((item) => item.enabled)!;
    const original = { ...rule, conditions: rule.conditions.map((condition) => ({ ...condition })), skill_ids: [...rule.skill_ids] };
    const skill = ws.skills.find((item) => item.name === "Billing")!;
    rule.match = "all";
    rule.conditions = [{ field: "subject", op: "contains", value: "skill preview" }];
    rule.skill_ids = [skill.id];
    qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    await act(async () => root.render(<QueryClientProvider client={qc}><TooltipProvider><ConfirmProvider><Routing /></ConfirmProvider></TooltipProvider></QueryClientProvider>));
    for (let i = 0; i < 100 && (!qc.getQueryData(qk.skills) || !el.querySelector('input[placeholder="Question about my invoice"]')); i++) await settle();
    const subject = el.querySelector<HTMLInputElement>('input[placeholder="Question about my invoice"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(subject, "skill preview");
      subject.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();
    const run = [...el.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Test");
    expect(run).toBeDefined();
    await act(async () => run!.click());
    for (let i = 0; i < 50 && !el.textContent?.includes("Required skills"); i++) await settle();
    expect(el.textContent).toContain("Required skills");
    expect(el.textContent).toContain("Billing");
    Object.assign(rule, original);
  });

  it("returns required skills in the mock routing result", () => {
    const skill = ws.skills[0];
    const rule = {
      id: "skill-rule-test", name: "Billing questions", enabled: true, position: -1, run_count: 0,
      match: "all" as const, conditions: [{ field: "subject" as const, op: "contains" as const, value: "skill test" }],
      team_id: ws.teams[0].id, skill_ids: [skill.id], created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    const prior = ws.routingRules;
    ws.routingRules = [rule, ...prior];
    const result = evaluateRouting(ws, { channel: "email", to: ws.mailboxes[0].email, subject: "Skill test", body: "" });
    expect(result.routed?.rule_id).toBe(rule.id);
    expect(result.required_skills.map((item) => item.id)).toEqual([skill.id]);
    ws.routingRules = prior;
  });
});

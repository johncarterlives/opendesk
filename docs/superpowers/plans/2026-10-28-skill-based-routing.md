# Skill-Based Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route tickets to online, under-cap team members who hold every skill required by the first matching routing rule.

**Architecture:** Add a workspace-scoped skill catalog with normalized member, rule, and ticket relationships. Routing rules produce the ticket requirements; shared ticket creation persists them; the existing assignment transaction filters eligible members without changing team selection or assignment modes. Expose configuration in existing settings pages and required skills in ticket detail and routing tests.

**Tech Stack:** Go, huma v2, pgx/Postgres migrations, React, TypeScript, TanStack Query, Tailwind v4, i18next.

**Spec:** `docs/superpowers/specs/2026-10-28-skill-based-routing-design.md`

## Global Constraints

- Keep the existing routing order and team-selection semantics intact.
- Matching requires all listed skills; an empty list means no skill filter.
- A ticket's selected rule supplies both its team and its required skills.
- Keep the current assignment modes and round-robin cursor behavior.
- Use a new migration above the highest migration on `main`; verify the target version immediately before implementation.
- Follow workspace-scoped row checks, transactional events, audit logging, Go formatting, and web design conventions in `AGENTS.md`.
- Run `pnpm qa` in `qa/` on the committed HEAD before opening a PR and after every follow-up implementation commit.

## Review Focus

- A ticket routed under a rule with multiple skills is eligible only for a member holding every skill; cover in Task 3's assignment tests.
- An archived skill cannot be added to a new or edited rule, while existing tickets and member assignments retain its identity; cover in Task 1 and Task 2 tests.
- A ticket changing teams keeps its requirements and remains unassigned if the new pool has no full match; cover in Task 3 tests.
- Concurrent removal of a member skill cannot allow a stale eligibility check to commit an assignment; cover in Task 3's transaction-level test.
- Ticket skill names respect ticket workspace and private-team visibility; cover in Task 3's domain/API tests.

---

### Task 1: Skill catalog and member assignments

**Files:**
- Create: `migrations/000702_ticket_skills.up.sql` (recheck against `upstream/main` immediately before creating; renumber if main has advanced)
- Create: `migrations/000702_ticket_skills.down.sql` (same version as its up migration)
- Create: `internal/helpdesk/routing/skills.go`
- Create: `internal/helpdesk/routing/skills_test.go`
- Modify: `internal/helpdesk/routing/api.go`
- Modify: `contracts/teams.md`
- Modify: `contracts/events.md`

**Interfaces:**
- Produces `Skill { ID uuid.UUID, Name string, Archived bool, MemberIDs []uuid.UUID }` in `internal/helpdesk/routing`.
- Produces admin settings endpoints: `GET /v1/skills`, `POST /v1/skills` with `{name}`, `PATCH /v1/skills/{id}` with `{name?, archived?}`, and `PUT /v1/skills/{id}/members` with `{member_ids: string[]}`.
- The skills API accepts workspace settings read/write authorization, validates members and IDs against the principal's workspace, publishes skill events and audit entries in the same transaction, and rejects archiving while any enabled routing rule references the skill.
- The migration creates workspace-scoped skill catalog, member-skill, routing-rule-skill, and ticket-skill relations with workspace-safe foreign keys and uniqueness constraints. Catalog rows are soft-archived; relations used by existing tickets remain intact.

- [ ] **Step 1: Add API tests** for workspace isolation, settings read/write permissions, duplicate names, member role/workspace validation, member assignment replacement, and rejecting archive while an enabled rule requires the skill.
- [ ] **Step 2: Run the focused test** with `go test ./internal/helpdesk/routing -run 'TestSkills' -count=1`; expected: the new tests fail because the endpoints and tables are missing.
- [ ] **Step 3: Add the migration and skill endpoints** in the files listed above. Add, rename, and member-assignment writes must publish events and audit records in their database transaction. Preserve member assignments when a skill is archived.
- [ ] **Step 4: Run the focused test** with `go test ./internal/helpdesk/routing -run 'TestSkills' -count=1`; expected: PASS.
- [ ] **Step 5: Update the contracts** for skill endpoint payloads, access, archive semantics, and skill events; verify `git diff --check`.
- [ ] **Step 6: Commit and run `pnpm qa`** on the committed HEAD.

### Task 2: Routing rules select required skills

**Files:**
- Modify: `internal/helpdesk/routing/rules.go`
- Modify: `internal/helpdesk/routing/routing.go`
- Modify: `internal/helpdesk/routing/api.go`
- Modify: `internal/helpdesk/routing/routing_test.go`
- Modify: `contracts/teams.md`
- Modify: `contracts/api.md`

**Interfaces:**
- Consumes Task 1's `Skill` catalog and `routing_rule_skills` relation.
- Produces `RoutingRule.SkillIDs []uuid.UUID` and `routing.Result.RequiredSkillIDs []uuid.UUID`.
- `POST /v1/routing/test` returns `required_skills: Skill[]` from the first matching rule; no match returns an empty array.

- [ ] **Step 1: Add routing tests** proving first-match behavior returns that rule's skills, an empty skill list stays empty, archived skills cannot be added to a rule, and a rule with several requirements returns every selected skill.
- [ ] **Step 2: Run the focused test** with `go test ./internal/helpdesk/routing -run 'TestRouting.*Skill|TestRoutingTest.*Skill' -count=1`; expected: tests fail before rule persistence and resolution support.
- [ ] **Step 3: Extend rule read, create, and update paths** to load and persist normalized skill IDs, validate all IDs in the workspace and reject archived skills. Preserve omitted `skill_ids` on PATCH and accept an explicit empty list to clear requirements.
- [ ] **Step 4: Extend `Resolve` and `RoutingTestResult`** so the first matched rule supplies its skill IDs and names alongside its team; leave existing non-rule team resolution unchanged.
- [ ] **Step 5: Run the focused routing tests** with `go test ./internal/helpdesk/routing -run 'TestRouting.*Skill|TestRoutingTest.*Skill' -count=1`; expected: PASS.
- [ ] **Step 6: Update routing contracts**, run `git diff --check`, commit, and run `pnpm qa` on the committed HEAD.

### Task 3: Persist ticket skills and filter automatic assignment

**Files:**
- Modify: `internal/domain/write.go`
- Modify: `internal/domain/types.go`
- Modify: `internal/domain/load.go`
- Modify: `internal/helpdesk/tickets/trigger.go`
- Modify: `internal/helpdesk/routing/routing_test.go`
- Modify: `internal/helpdesk/tickets/trigger_test.go`
- Modify: `contracts/api.md`
- Modify: `contracts/events.md`

**Interfaces:**
- Consumes Task 2's `routing.Result.RequiredSkillIDs`.
- Produces `domain.NewTicket.RequiredSkillIDs []uuid.UUID` and a domain-owned `domain.TicketSkill { ID uuid.UUID, Name string }` reference type in `domain.Ticket.RequiredSkills`; `internal/domain` must not import `internal/helpdesk/routing`.
- Shared creation persists required skill IDs in `ticket_skills`; ticket reads add skill references through the existing workspace and visibility-scoped ticket query path.
- `PickAssignee` receives the ticket's required skill IDs and filters the existing candidate set to members with all requirements before applying the configured assignment mode.

- [ ] **Step 1: Add tests** that shared ticket creation persists required skills, ticket loads include them, non-matching members are excluded, all skills are required, tickets without requirements preserve current selection, and a team change retains requirements while leaving a ticket unassigned when no member matches.
- [ ] **Step 2: Run focused tests** with `go test ./internal/domain ./internal/helpdesk/tickets ./internal/helpdesk/routing -run 'Test.*(Skill|Assign|Route)' -count=1`; expected: new skill cases fail before persistence/filtering exists.
- [ ] **Step 3: Pass the routing result into every shared ticket creation path** (email, API, widget, and phone) and persist requirements through `domain.CreateTicket`; do not add a parallel ticket writer.
- [ ] **Step 4: Add required skill references to `domain.Ticket` reads** without bypassing `domain.LoadVisibleTicket`, `VisibleSQL`, or `VisibleSQLUser` private-team checks. Keep legacy tickets' skill arrays empty.
- [ ] **Step 5: Filter `PickAssignee` candidates** by every ticket requirement while preserving team pool, presence, role, capacity, cursor, and balancing semantics. Lock the qualifying member-skill rows with `FOR KEY SHARE`, verify the locked row count covers every required skill, and hold those locks through the assignee write; a concurrent skill removal then either commits first and fails the recheck or waits until assignment commits.
- [ ] **Step 6: Add transaction-level tests** for member-skill removal versus assignment and verify ticket requirements remain unchanged when the team changes. Assert private-team-hidden tickets do not expose skill references through single-ticket or list responses.
- [ ] **Step 7: Run focused Go tests and update API/event contracts**, then `gofmt` touched Go files, commit, and run `pnpm qa` on the committed HEAD.

### Task 4: Configure skills and show routing outcomes in the web app

**Files:**
- Modify: `web/src/pages/settings/Assignment.tsx`
- Modify: `web/src/pages/settings/RoutingRuleEdit.tsx`
- Modify: `web/src/pages/settings/Routing.tsx`
- Modify: `web/src/components/tickets/detail/TicketProperties.tsx`
- Modify: `web/src/lib/api/types.ts`
- Modify: `web/src/lib/api/endpoints.ts`
- Modify: `web/src/lib/queries.ts`
- Modify: `web/src/lib/realtime/apply.ts`
- Modify: `web/src/mock/handlers/teams.ts`
- Modify: `web/src/mock/teams.ts`
- Modify: `web/src/i18n/locales/{en,de,fr}/settingsInbox.json`
- Modify: `web/src/i18n/locales/{en,de,fr}/settingsTeams.json`
- Test: `web/src/pages/settings/Assignment.test.tsx`
- Test: `web/src/pages/settings/RoutingRuleEdit.test.tsx`
- Test: `web/src/components/tickets/detail/TicketProperties.test.tsx`

**Interfaces:**
- Consumes the Task 1 skills endpoints and Task 2/3 API shapes.
- Produces typed `Skill`, `RoutingRule.skill_ids`, `RoutingTest.required_skills`, and `Ticket.required_skills` frontend fields plus a `q.skills()` query and skill mutation endpoints.
- Settings UI edits the skill catalog and member assignments on Assignment, lets admins choose required skills in the routing rule editor, and displays the matched rule's skills in the routing test result. Ticket details display the ticket's required skill labels, including when unassigned.

- [ ] **Step 1: Add component tests** for admin-only skill editing, assigning skills to a member, selecting and clearing rule skills, routing test skill display, and ticket skill labels for assigned and unassigned tickets.
- [ ] **Step 2: Run the focused web tests** with `pnpm --dir web test --run src/pages/settings/Assignment.test.tsx src/pages/settings/RoutingRuleEdit.test.tsx src/components/tickets/detail/TicketProperties.test.tsx`; expected: new tests fail before the UI and API types are present.
- [ ] **Step 3: Add API types, endpoint methods, query keys, and realtime invalidation** for skill catalog and skill events.
- [ ] **Step 4: Implement the Assignment and Routing rule controls** using existing settings patterns, with archived skills unavailable for new rules and existing archived ticket labels still displayable.
- [ ] **Step 5: Render ticket and routing test skill labels** using the existing semantic label and surface tokens; preserve keyboard and theme behavior.
- [ ] **Step 6: Update mock handlers and fixtures** so local demo mode supports catalog management, rule requirements, routing tests, and ticket detail labels.
- [ ] **Step 7: Add English, German, and French copy; run focused web tests and formatting/type checks**, commit, and run `pnpm qa` on the committed HEAD.

### Task 5: Final contract and integration verification

**Files:**
- No planned file changes; contract updates belong to the task that introduces each interface.

- [ ] **Step 1: Review spec coverage** across skill management, rules, strict assignment, no fallback, ticket display, archive lifecycle, team changes, and visibility; if an integration fix is needed, amend the owning task's files, commit it, and rerun `pnpm qa`.
- [ ] **Step 2: Run `scripts/check-migrations.sh`** and verify the new migration is above current main and the last release.
- [ ] **Step 3: Run `go build ./... && go vet ./...`**; expected: both complete successfully.
- [ ] **Step 4: Run `pnpm qa` from `qa/`** on the committed HEAD; expected: all checks for Go, web, database migrations, and changed areas pass.
- [ ] **Step 5: Confirm the final HEAD is committed and clean**; rerun `pnpm qa` if any verification fix changed the tree.

# Skill-Based Routing Design

**Status:** Draft for review

## Intent

Opendesk already chooses a team from the mailbox, widget topic, routing rules, triage, or automation. It then assigns an unassigned ticket among that team's online members using the configured round-robin or load-balanced mode and each member's open-ticket cap. This spreads work across a team but cannot account for expertise such as language, product area, or billing knowledge.

This feature lets a workspace describe agent skills and require those skills on tickets selected by routing rules. Automatic assignment keeps the existing team and workload behavior, while limiting candidates to agents who have every required skill.

## Goals

- Let admins create and manage a workspace skill list, such as `French`, `Billing`, or `Mobile app`.
- Let admins assign one or more skills to workspace members.
- Let a routing rule require one or more skills on tickets it matches.
- Persist the rule's required skills on the ticket so later automatic assignment uses the same requirements.
- Choose an assignee from the existing eligible team pool, requiring all ticket skills and retaining the current availability, open-ticket cap, round-robin, and load-balanced behavior.
- Let agents see the required skills on a ticket and let admins test which skills a routing rule would apply.
- Keep tickets with no required skills on the current assignment path.

## Non-goals

- Infer skills from ticket text with Ollie or another model.
- Add skills to widget topics, mailboxes, or phone-number settings independently of routing rules.
- Add per-channel capacity, unified channel queues, skill timeouts, or a preference score.
- Reassign tickets solely because an admin changes a member's skills or edits a routing rule. Existing trigger points still retry assignment for an unassigned ticket: creation, customer reply, or team change.
- Prevent an agent from manually assigning a ticket to themselves or another agent. Skills constrain automatic assignment only.
- Backfill skill requirements onto tickets created before this feature.

## Behavior

### Skill management

Admins manage workspace skills from **Settings → Assignment**. Each skill has a workspace-unique name and may be assigned to multiple members. Only admins can create, rename, archive, or change member skill assignments. Only owners, admins, and agents can hold skills; viewers and suspended members are never automatic-assignment candidates. Archiving hides a skill from new or edited routing rules and member profile editing. Existing member assignments remain usable by tickets that already require that skill. An enabled rule that still requires the skill must be edited before the skill can be archived. Skills referenced by existing tickets are soft-archived, not deleted, so their identity and display label remain available.

Skill IDs and member assignments are workspace-scoped. The API validates every referenced member and skill against the authenticated workspace. Removing a skill from a member immediately removes that member from future automatic matches.

### Routing rules

A routing rule keeps its current conditions, order, and team. It can additionally list required skill IDs. The first matching rule remains the only rule that determines the new ticket's team and required skills. A rule without skills behaves as it does today. Skills are not an independent rule condition; the rule's existing conditions select the ticket, and its skill list describes the expertise needed to work it. A rule cannot require an archived skill.

The routing test response shows the matched rule's required skill names and IDs. Rule edits apply to new tickets only; they do not rewrite requirements already stored on tickets.

### Assignment

For each current auto-assignment trigger, the candidate pool remains the ticket team's leads and members, or the existing mailbox/workspace fallback when the ticket has no team. Candidates must still be online, within their open-ticket cap, and eligible by their workspace role. A candidate must have every required skill on the ticket. The assignment transaction must keep skill eligibility valid through the assignee write; concurrent removal of a required member skill must not allow a stale match to commit.

The selected round-robin or load-balanced mode runs over only those matching candidates. A ticket with no eligible skill match remains unassigned; the system does not silently assign it to an unqualified agent. Existing new-ticket and customer-reply notifications continue to apply when it remains unassigned. An admin or agent can still assign it manually.

Tickets without required skills, and tickets created before the feature, keep current assignment behavior. A team change preserves the ticket's required skills. If the new team's eligible pool has no full skill match, the ticket stays unassigned until a later existing retry trigger or a manual assignment.

### Agent experience

The ticket shows its required skills as compact labels in the ticket details, including when it is unassigned. Agents can use that information to understand the route. There is no manual skill editor on an individual ticket in this release.

## Data and API shape

Use normalized, workspace-scoped records for the skill catalog, member-to-skill assignments, routing-rule requirements, and ticket requirements. Avoid storing names as the relationship because names can change while an open ticket still needs the same skill identity.

Extend `RoutingRule` with `skill_ids`; extend the routing result with the selected skills; persist those IDs during normal ticket creation in the same transaction as the ticket. Extend the ticket response with resolved `required_skills` for display. Add admin-only skill management endpoints, and publish/audit skill and member-skill changes using the repository's existing workspace settings patterns.

All writes that affect visible settings or tickets run in a transaction with their event. Ticket visibility remains governed by the existing private-team checks. The new ticket-skill relation is read only after the ticket's workspace and visibility have been established.

## Constraints

- Keep the existing routing order and team-selection semantics intact.
- A ticket's selected rule supplies both its team and its required skills.
- Matching requires all listed skills; an empty list means no skill filter.
- Keep the current assignment modes and round-robin cursor behavior.
- Use a new migration above the current `main` migration version; verify the target version immediately before implementation.
- Follow the workspace-scoped row checks, transactional events, audit logging, Go formatting, and web design conventions in `AGENTS.md`.

## Review focus

- Archiving a skill used by an enabled rule is rejected until that rule is edited; existing ticket requirements retain the archived skill's label and ID.
- A member loses a skill while the member is being selected for assignment.
- A ticket changes teams and retains its skills; with no matching member it remains unassigned.
- A ticket with several skills is assigned only when a candidate has every one of them.
- A user outside a private team cannot learn its ticket's required skills from a list, event, or API response.

## Decisions made for this draft

- Skills are required, not preferred; no fallback to an unqualified agent occurs automatically.
- Routing rules are the initial source of ticket skill requirements.
- Skill changes do not trigger a workspace-wide reassignment sweep; existing ticket triggers remain responsible for retries.
- The initial implementation stays on the existing team assignment flow rather than introducing a separate queue or assignment service.
- Skills are archived rather than hard-deleted. An enabled rule must stop requiring a skill before it can be archived; existing tickets and member assignments retain the archived skill reference.
- A ticket's skill requirements survive team changes. Assignment checks and assignee writes share a transaction boundary that prevents a concurrent member-skill removal from authorizing a stale match.

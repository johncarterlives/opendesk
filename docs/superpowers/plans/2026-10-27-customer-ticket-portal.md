# Customer ticket portal implementation plan

> **For agentic workers:** Implement this plan task-by-task in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each existing contact a secure, branded help-center portal for their own support tickets and public replies.

**Architecture:** Add a customer-only identity and API boundary under `internal/helpdesk/customerportal`; build the interactive portal as a public Vite React route on the app origin, following the existing CSAT page pattern. Keep help-center articles in the Go-rendered site and add a branded link to the app route. Resolve customer access from a dedicated token purpose and live session, and route ticket reads/writes through contact-scoped SQL and the shared domain message path.

**Tech Stack:** Go, huma/chi, PostgreSQL migrations, River jobs, React, Vite, TanStack Router/Query, existing public components and locale catalogs, `pnpm qa`.

**Spec:** `docs/superpowers/specs/2026-10-27-customer-ticket-portal.md`

## Global Constraints

- Always create tickets and messages through `domain.CreateTicket` / `domain.AddMessage`.
- Passwords use Argon2id through `auth.HashPassword` and `auth.CheckPassword`.
- Every workspace-owned row is read and written with the workspace derived from the authenticated principal, never the request body.
- Writes that others should see run in one transaction with `events.Publish`; follow-up work is enqueued with `d.Jobs.InsertTx` in that same transaction.
- Customer-facing text uses `internal/templates`; stored HTML must be sanitized before rendering.
- Run `gofmt -w` on touched Go files, then `go build ./... && go vet ./...`.
- Run `pnpm qa` on the committed HEAD before opening a pull request and after follow-up commits.
- Use the repository's `feat/` branch prefix; never use `codex/`.

## Review Focus

- A token from one customer cannot list, read, or reply to a different contact's ticket, even when it knows the ticket ID.
- A reset token submitted to another workspace is rejected without consuming the valid token.
- A contact blocked, deleted, or changed to another email loses access immediately, including refresh.
- No private note, side conversation, deleted/purged message, spam ticket, or failed sender-check reply reaches the portal.
- The portal's app-to-API requests use credentialed CORS from the configured app origin; the public help-center worker does not receive customer auth cookies or bearer tokens.
- Customer page requests and cache entries cannot reuse the agent account's access token, cache, or workspace scope.
- Reset tokens are removed from the app URL immediately and are not sent in a referrer or analytics event.

---

### Task 1: Customer identity, sessions, and password setup

**Files:**
- Create: `migrations/000701_customer_portal.up.sql` and `.down.sql` (recheck and renumber above current `main` before implementation)
- Create: `internal/helpdesk/customerportal/config.go`, `auth.go`, `auth_test.go`, `workers.go`
- Create: `internal/emails/customer_portal.go`
- Modify: `internal/auth/principal.go`, `tokens.go`, `middleware.go`
- Modify: `internal/jobs/args.go`, `internal/helpdesk/register.go`
- Modify: `internal/helpdesk/contacts/contacts.go` for lifecycle revocation
- Modify: `contracts/tokens.md`, `contracts/teams.md`

**Interfaces:**
- Produces `auth.RequireCustomer(ctx) (*auth.Principal, error)` with a customer principal containing only workspace, contact, session, IP, and user-agent identity.
- Produces `customerportal.Register`, `RegisterWorkers`, and `Periodic` hooks matching the helpdesk package registration conventions.
- Public brand-config and auth operations are scoped by help-center slug; login returns a short-lived customer access token and sets a rotating, opaque refresh cookie.
- The public config DTO contains only brand title, logo URL, colour, locale, locale-fixed state, and server-derived current help-center URL (verified active custom host or configured default address).

- [ ] Write integration tests for public brand config, unknown/known login equivalence, password setup and reset, rate limits, reset-token replay/expiry/workspace scope, session rotation/revocation, blocked contacts, changed email, and deleted contacts.
- [ ] Run `TEST_DATABASE_URL=<fresh test database> go test ./internal/helpdesk/customerportal ./internal/auth ./internal/captcha` and confirm the new tests fail for missing behavior.
- [x] Add a separate credentials/session/reset schema, keeping contact identity outside workspace-member tables. Pick the migration number above the current `main` and last release.
- [x] Implement the customer token purpose and principal resolution. Every protected request rechecks a live session, contact email snapshot, contact block state, and workspace suspension.
- [x] Implement public brand config, login, uniform forgot-password response, one-time reset, password hashing/checking, audit events, and contact-lifecycle invalidation using existing CAPTCHA, rate-limit, email, and River patterns. Validate CAPTCHA for the configured app hostname, since the form is on the app origin.
- [x] Run `gofmt -w` on touched Go files and rerun the focused Go tests; confirm all pass.
- [x] Commit as `feat: add customer portal identity`.

### Task 2: Contact-scoped ticket history and replies

**Files:**
- Create: `internal/helpdesk/customerportal/tickets.go`, `tickets_test.go`
- Modify: `contracts/api.md`

**Interfaces:**
- Produces bounded `GET /v1/customer/portal/tickets` and `GET /v1/customer/portal/tickets/{id}` responses with explicit customer DTOs.
- Produces paginated `GET /v1/customer/portal/tickets/{id}/messages` and plain-text `POST .../messages`.
- Consumes `auth.RequireCustomer`; derives both workspace and contact from the returned principal.

- [x] Write integration tests for own-contact visibility, cross-contact/cross-workspace `404`, public-message filtering, pagination order, reply sanitization, event publication, and normal status behavior.
- [ ] Run `TEST_DATABASE_URL=<fresh test database> go test ./internal/helpdesk/customerportal` and confirm the new endpoint tests fail.
- [x] Implement bounded SQL reads keyed by both workspace and contact. Exclude spam/deleted tickets and non-public or removed messages; return plain text only.
- [x] Implement replies in a transaction with `domain.AddMessage`, `hd.TextToHTML`, contact attribution, and the existing customer-replied job/event behavior.
- [x] Run `gofmt -w` and rerun the focused Go tests; confirm all pass.
- [x] Commit as `feat: add customer ticket history and replies`.

### Task 3: React customer portal and help-center entry point

**Files:**
- Modify: `web/src/router.tsx`, `web/src/i18n/index.ts`
- Create: `web/src/pages/public/CustomerPortal.tsx`, `web/src/pages/public/CustomerPortal.test.tsx`
- Create: `web/src/lib/customerPortal/client.ts`, `web/src/lib/customerPortal/queries.ts`, `web/src/lib/customerPortal/types.ts`
- Modify: `web/src/lib/api/types.ts` and public locale catalogs as the shared API/i18n conventions require
- Modify: `internal/helpdesk/helpsite/helpsite.go`, `internal/helpdesk/helpsite/render.go`, `internal/helpdesk/helpsite/templates/page.html` for the app-origin portal link
- Test: `internal/helpdesk/helpsite/helpsite_test.go`

**Interfaces:**
- Adds public routes `/portal/$slug`, `/portal/$slug/forgot`, `/portal/$slug/reset`, and `/portal/$slug/tickets/$ticketId` outside `appLayout`.
- Uses a dedicated customer API client with an explicit customer access token and `credentials: "include"`; refresh sends the route's workspace slug only as a context check, and the cookie session remains authoritative. Concurrent refresh attempts are single-flight because the cookie is single-use. It never reads or writes the agent client's active token.
- Stores customer access tokens in memory only, namespaces query keys under `customerPortal`, and clears those entries on logout or account change.
- The help-center header links to `APP_URL/portal/<slug>`; the React page gets public brand config from Task 1.

- [x] Write React tests for public route classification, login/reset/list/detail states, agent/customer token isolation, refresh-cookie requests, cache clearing on logout, keyboard behavior, weak-password login handling, and reset-token removal before any request/referrer or analytics capture. Test public config help-center URLs for both active custom domains and the configured default address.
- [ ] Run `cd web && pnpm vitest run src/pages/public/CustomerPortal.test.tsx` and confirm the new tests fail. The initial-red output was not preserved in the implementation report.
- [x] Add public routes outside the agent layout and include `/portal` in `isPublicPath`. Capture reset tokens before router history subscribes, remove them from the address, and keep them only in memory. Follow the public CSAT locale, shell, title, and responsive patterns.
- [x] Implement the dedicated customer API client and query hooks; keep customer requests out of the agent client. Refresh sends `{workspace_slug}` as a context check and deduplicates concurrent requests. Weak-password login issues no token/session and clears the refresh cookie. Use shared Turnstile components on login, forgot, and reset.
- [x] Build public sign-in/reset, request history, and ticket transcript/reply pages with shared components, app tokens and brand config; cover mobile, keyboard, reduced motion, themes, and RTL in the implementation.
- [x] Add the help-center header link to the app route and test its brand slug.
- [x] Add portal copy to supported public locale catalogs; test locale fallback and interpolation.
- [x] Run focused React, real-router reset, query-key and helpsite tests; confirm all pass.
- [x] Commit as `feat: add customer portal pages` and commit the scoped review fixes separately.

### Task 4: Contract review and repository QA

**Files:**
- Create: `contracts/customer-portal.md`
- Modify: `docs/src/content/docs/guides/help-center-addresses.mdx` and the relevant help-center setup documentation
- Modify: affected tests or implementation files only where review finds a gap

- [x] Document identity setup, portal visibility, customer routes, reset behavior, and the limitations of the first release.
- [ ] Review the feature against every acceptance check in the spec and every item in **Review Focus**.
- [ ] Run `scripts/check-migrations.sh`, `go build ./...`, `go vet ./...`, and `pnpm qa` on a committed HEAD; resolve failures and rerun after each follow-up commit.
- [ ] Capture a mobile and desktop portal walkthrough/stills through the repository's QA conventions.
- [ ] Commit the final documentation and verification artifacts.

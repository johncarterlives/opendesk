# Customer ticket portal

## Goal

Let an existing contact securely follow their own support tickets from the workspace help center and reply to the support team.

Issue #149 asks for contacts to have an account without receiving a generated password or an automatic password email. A contact who wants portal access should set their password through the help center's password-reset flow. The issue's separate request to assign an agent on the first reply is outside this feature.

## Customer experience

- The Go-rendered help center has a clear **Sign in** entry that opens the React portal at `APP_URL/portal/<brand-slug>`. The portal loads the public brand title, logo, colour, locale, and current help-center URL, then uses the app's public-page shell and design tokens.
- A customer signs in with the email already on their contact and a password they set through **Forgot password?**. Creating or importing a contact sends no portal invitation.
- The customer sees their requests, opens a request, reads the public conversation, and replies. They can sign out or request another password link.
- The empty state points back to the help center so customers can find its existing support channels.

## Access and data boundaries

- A customer identity is one contact in one workspace. It is not a workspace member, viewer, API key, or widget visitor.
- The help center slug resolves the workspace for login and reset. Authenticated requests take workspace and contact IDs from the live customer session, never from a request body or query parameter.
- A customer can list, read, and reply only to tickets whose `workspace_id` and `contact_id` both match the authenticated identity. A ticket belonging to another contact or workspace returns `404`.
- Lists omit deleted and spam tickets and use bounded cursor pagination.
- Portal conversation responses contain only public replies: no notes, internal threads, activities, hidden agent fields, deleted or purged content, or failed sender-check messages. Return text, not stored HTML.
- Customer replies are plain text, converted with the existing safe text-to-HTML helper, and written through `domain.AddMessage` in the regular transaction/event path. Do not provide ticket creation, status changes, CCs, file uploads, or organization-wide visibility in this release.

## Identity and security

- An email-bearing contact is eligible for account setup. The portal stores a password only after the contact follows a valid reset link and chooses one. It never generates or sends a password.
- Passwords use `auth.CheckPassword` and `auth.HashPassword`. Login, setup, and reset use the configured human check and shared rate limits. If a previously valid password no longer meets policy, login returns `change_password` without issuing an access token or refresh session; it revokes existing customer sessions and clears the refresh cookie. The customer must use a new password link before portal access.
- Forgot-password responses do not reveal whether an eligible contact exists. Reset tokens are high entropy, hashed at rest, single-use, expire, and are bound to the workspace, contact, and email that received them.
- Customer access tokens have their own purpose and principal kind. Customer credentials cannot pass workspace member or visitor authorization and cannot call agent ticket APIs.
- Refresh credentials are hashed and rotated. Browser refresh cookies are HttpOnly, Secure on HTTPS, SameSite=Lax, host-only, and never returned in a response body.
- Blocked contacts, deleted contacts, changed email addresses, expired/revoked sessions, and suspended workspaces cannot use stale credentials. Password reset ends the contact's other sessions and reset links.
- Customer data is fetched by the React page and is never server-rendered or cached in public HTML. Portal routes are noindex; the reset route reads the one-time token and removes it from browser history before any request/referrer or analytics capture. The existing analytics client defers itself while a token query parameter is present.
- The app route is on the configured app origin. It uses the existing app-to-API CORS and credentialed-fetch pattern; the help-center worker continues to forward only public anonymous content.

## Routes and frontend ownership

The Go help-center renderer remains responsible for articles, collections, changelog pages, and its SEO. It adds a link to the Vite portal and does not render portal UI.

React pages on the app origin:

- `/portal/<brand-slug>` (sign in or signed-in request list)
- `/portal/<brand-slug>/forgot`
- `/portal/<brand-slug>/reset`
- `/portal/<brand-slug>/tickets/<ticket-id>`

The public portal follows the React CSAT route pattern: it sits outside the agent app layout, loads public locale resources, and uses shared React components and tokens. Its customer token state and query keys are separate from the agent account client and cache.

Public auth API:

- `GET /v1/public/help/{workspace_slug}/portal/config` (public title, logo, colour, locale, locale-fixed state, and server-derived current help-center URL only)
- `POST /v1/public/help/{workspace_slug}/portal/auth/login`
- `POST /v1/public/help/{workspace_slug}/portal/auth/forgot`
- `POST /v1/public/help/{workspace_slug}/portal/auth/reset`

Authenticated customer API:

- `POST /v1/customer/portal/auth/refresh` with the current help-center `workspace_slug` as a context check; the cookie session remains authoritative for workspace/contact identity.
- `POST /v1/customer/portal/auth/logout`
- `GET /v1/customer/portal/tickets`
- `GET /v1/customer/portal/tickets/{id}`
- `GET /v1/customer/portal/tickets/{id}/messages`
- `POST /v1/customer/portal/tickets/{id}/messages`

## Visual design

Use the Vite React public-page pattern already used by CSAT, not a second JavaScript app embedded into the Go help-center renderer. Keep the agent app's sidebar and workspace shell out of portal routes.

- Palette: white `#ffffff` for content; `#fafafa` for quiet backgrounds; `#e4e4e4` for separators; `#0a0a0a` for primary text; `#4a4a4a` for secondary text; existing blue `#2b6cf0` for primary actions and focus.
- Type: the help center's Geist Variable family, with its current body and heading scale.
- Alignment: left-aligned content in the public page's centered reading column. Use divided ticket rows and semantic status pills, not a grid of identical cards.
- The one strong accent is the existing brand identity in the help-center header. Forms and ticket content remain quiet and readable in light and dark themes.
- Keep the reply composer in reach at the bottom of a ticket conversation, including on mobile; respect the virtual keyboard, safe area, visible focus, reduced motion, and right-to-left languages.

Request list sketch:

```text
┌ Brand help                                Help center   Sign in ┐
│ Your requests                                      [Sign out]   │
│                                                                  │
│ Order question                    Open        #1042  Updated ... │
│ Account access                    Waiting     #1038  Updated ... │
│ Previous delivery                 Solved      #1019  Updated ... │
└──────────────────────────────────────────────────────────────────┘
```

Conversation sketch:

```text
┌ Brand help                                Help center   Sign out ┐
│ #1042 · Order question                         Status: Open     │
│                                                                  │
│ Support team                                      10:32          │
│ We are checking the delivery with the carrier.                  │
│                                                                  │
│ You                                               10:40          │
│ Thanks. The parcel is still not here.                            │
│                                                                  │
│ Reply to support                                                  │
│ [ Write a reply…                                      ] [Send]   │
└──────────────────────────────────────────────────────────────────┘
```

## Acceptance checks

- An eligible customer can set a password by email, sign in on the correct help center, list their tickets, read public replies, reply, refresh, and sign out.
- Unknown and known email addresses receive the same forgot-password response.
- A second contact, another workspace, a blocked contact, and a contact with a changed email cannot access the original session's tickets.
- Private notes, internal threads, deleted/purged messages, spam/deleted tickets, and failed sender-check replies never appear.
- Reset tokens cannot be reused, expired, or consumed by a request against another workspace.
- The help-center link reaches the app route for the right brand slug. The React page works on Cloudflare Pages and in the self-hosted Vite bundle, on mobile, with keyboard navigation and the app's public locales and themes.

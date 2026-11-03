# Customer ticket portal

The customer portal lets an existing help-center contact follow and reply to their own support tickets. It is a public React page served by the app, backed by a separate customer identity and API boundary. The Go help-center continues to serve articles and the changelog.

## Identity and access

A customer identity belongs to one contact in one workspace. It is not a workspace member, API key, or widget visitor. Creating or importing a contact does not send an invitation or create a password. An existing contact sets a password by requesting a password link from the portal.

The help-center slug selects the workspace for public login and password-link requests. The resulting customer session is authoritative for both workspace and contact. Protected routes ignore `OD-Workspace` and derive the identity from the live session. A customer can list, read, and reply only to tickets where both `workspace_id` and `contact_id` match that identity. Tickets from another contact or workspace, and spam or deleted tickets, return `404`.

Each request resolves the live customer session and rechecks its expiry and revocation, the contact's email snapshot and blocked state, and workspace suspension. Changing a contact's email or blocking the contact invalidates credentials and sessions in the same transaction as the contact update. Deleting a contact removes its customer identity records. Password reset revokes other customer sessions and outstanding reset links.

## Passwords and sessions

Login, forgot-password and reset requests are rate limited and use the configured human check. Login uses a uniform invalid-credentials response for unknown contacts and incorrect passwords. Forgot-password responds uniformly and queues email lookup and delivery. Only an existing, unblocked contact with an email receives a link.

Reset links contain a random, single-use token stored only as a hash. The token is bound to its workspace, contact and email snapshot and expires after one hour. The portal removes the token from the browser address before making requests or initializing analytics. Passwords use the shared Argon2id password policy. A valid legacy password that no longer meets the current policy cannot create a session; the customer must set a compliant password through a new link.

Customer access JWTs use purpose `customer_access`, last 15 minutes, and are accepted only by customer portal routes. Refresh credentials are random opaque values stored hashed and rotated on use. A browser receives them only in an HttpOnly, host-only, SameSite=Lax cookie, secure on HTTPS. Refresh requires the current help-center slug as a context check; the cookie's live session remains the source of identity. Logout revokes the current session. Customer cookies and in-memory access tokens are separate from the agent app's credentials.

## Customer routes

The help-center renderer links to the app at `/portal/<brand-slug>`. The React portal provides:

- `/portal/<brand-slug>`: sign-in or request list
- `/portal/<brand-slug>/forgot`: request a password link
- `/portal/<brand-slug>/reset`: choose a password from a one-time link
- `/portal/<brand-slug>/tickets/<ticket-id>`: read and reply to a ticket

The page loads public brand configuration from `GET /v1/public/help/{workspace_slug}/portal/config`. It contains the title, logo, colour, locale, locale-fixed flag, and the server-derived current help-center URL. When a custom help-center domain is active, that domain is returned; otherwise the configured default URL is returned.

Authenticated ticket operations are `GET /v1/customer/portal/tickets`, `GET /v1/customer/portal/tickets/{id}`, `GET /v1/customer/portal/tickets/{id}/messages`, and `POST /v1/customer/portal/tickets/{id}/messages`. Lists use bounded cursor pagination. Message history includes public replies only, as text; it omits notes, side conversations, internal activities, deleted or purged messages, and messages whose sender check failed. Customer replies accept plain text and use the normal ticket message transaction, event, and customer-replied automation path.

The first release does not create tickets, change ticket status, upload files, add CCs, show organization-wide tickets, or expose side conversations. The customer routes are noindex and API responses are not stored in shared caches.

See [API routes](api.md#customer-portal-tickets) and [token rules](tokens.md#customer-portal) for wire details.

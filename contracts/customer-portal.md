# Customer ticket portal

The customer portal lets an existing help-center contact follow and reply to their own support tickets. It is a public React page served by the app, backed by a separate customer identity and API boundary. The Go help-center continues to serve articles and the changelog.

## Identity and access

A customer identity belongs to one contact in one workspace. It is not a workspace member, API key, or widget visitor. Creating or importing a contact does not send an invitation or create a password. An existing contact sets a password by requesting a password link from the portal, or from an invitation a team member sends ("Invitations").

The help-center slug selects the workspace for public login and password-link requests. The resulting customer session is authoritative for both workspace and contact. Protected routes ignore `OD-Workspace` and derive the identity from the live session. A customer can list, read, and reply only to tickets where both `workspace_id` and `contact_id` match that identity. Tickets from another contact or workspace, and spam or deleted tickets, return `404`.

Each request resolves the live customer session and rechecks its expiry and revocation, the contact's email snapshot and blocked state, and workspace suspension. Changing a contact's email or blocking the contact invalidates credentials and sessions in the same transaction as the contact update. Deleting a contact removes its customer identity records. Password reset revokes other customer sessions and outstanding reset links.

## Passwords and sessions

Login, forgot-password and reset requests are rate limited and use the configured human check. Login uses a uniform invalid-credentials response for unknown contacts and incorrect passwords. Forgot-password responds uniformly and queues email lookup and delivery. Only an existing, unblocked contact with an email receives a link.

Reset links contain a random, single-use token stored only as a hash. The token is bound to its workspace, contact and email snapshot and expires after one hour. The portal removes the token from the browser address before making requests or initializing analytics. Passwords use the shared Argon2id password policy. A valid legacy password that no longer meets the current policy cannot create a session; the customer must set a compliant password through a new link.

Customer access JWTs use purpose `customer_access`, last 15 minutes, and are accepted only by customer portal routes. Refresh credentials are random opaque values stored hashed and rotated on use. A browser receives them only in an HttpOnly, host-only, SameSite=Lax cookie, secure on HTTPS. Refresh requires the current help-center slug as a context check; the cookie's live session remains the source of identity. Logout revokes the current session. Customer cookies and in-memory access tokens are separate from the agent app's credentials.

## Invitations

A team member (agent role, or an API key with `contacts:write`) invites a contact to a brand's portal:
the contact gets a one-time link to choose a password, worded as an invitation and valid for 7 days. It is
a password link like the ones the portal sends, with the same rules: a random token stored only as a hash,
bound to its workspace, contact and email snapshot, and single use; it stops working after a password reset,
an email change, a block or a deletion. Links sent to one contact, requested or invited, are limited to 5 an hour, one
member's (or API key's) invitations to 200 an hour and one workspace's to 500 an hour, the last two counted for the
whole instance (`d.Limiter.Shared`). Each limit answers with its own `429` code: `rate_limited` (the contact),
`sender_rate_limited`, `workspace_rate_limited`; a bulk invitation counts the contacts it skipped under the same keys.

The invitation comes from a brand whose help center is on: the one asked for, else the default brand, else
the only one. A brand whose customers sign in only through its identity provider (`oidc`) has no password to
choose and is refused; its customers sign in there without an invitation. A contact without an email address,
a blocked contact and a missing one are refused, and skipped and counted in a bulk invitation of up to 100
contacts, which also skips contacts who already have access.

A contact's access, as members see it, is read from what exists: `active` with a password or a live provider
sign-in, `invited` with an open password link, otherwise `none`, with the newest open link and the last
sign-in among the portal sessions still kept (ended sessions are deleted 30 days on, so an active contact can have
none; the app then says no recent sign-in). Removing access deletes the password, revokes every portal session and closes every open link in one
transaction. A provider sign-in is left as it is: a customer who signs in through the brand's identity provider
can sign in again there, and blocking the contact keeps them out. Invitations and removals are audited
(`contact.portal_invited` with the brand, `contact.portal_access_removed`), never with a link or token.

## Customer routes

The help-center renderer links to the app at `/portal/<brand-slug>`. The React portal provides:

- `/portal/<brand-slug>`: sign-in or request list
- `/portal/<brand-slug>/forgot`: request a password link
- `/portal/<brand-slug>/reset`: choose a password from a one-time link
- `/portal/<brand-slug>/tickets/<ticket-id>`: read and reply to a ticket

The page loads public brand configuration from `GET /v1/public/help/{workspace_slug}/portal/config`. It contains the title, logo, colour, locale, locale-fixed flag, and the server-derived current help-center URL. When a custom help-center domain is active, that domain is returned; otherwise the configured default URL is returned.

Authenticated ticket operations are `GET /v1/customer/portal/tickets`, `GET /v1/customer/portal/tickets/{id}`, `GET /v1/customer/portal/tickets/{id}/messages`, and `POST /v1/customer/portal/tickets/{id}/messages`. Lists use bounded cursor pagination. Message history includes public replies only, as text; it omits notes, side conversations, internal activities, deleted or purged messages, and messages whose sender check failed. Customer replies accept plain text and use the normal ticket message transaction, event, and customer-replied automation path.

A signed-in customer can start a request (below). The portal does not change ticket status, take files, add CCs, show organization-wide tickets, or expose side conversations. The customer routes are noindex and API responses are not stored in shared caches.

See [API routes](api.md#customer-portal-tickets) and [token rules](tokens.md#customer-portal) for wire details.

## Per-brand OIDC configuration and identity ownership

Brands default to `portal_auth.mode: "local"`. Admins can choose `local`, `oidc`, or
`local_and_oidc` when creating or updating a brand. OIDC scopes are fixed to
`openid email profile`. Provider settings are read separately through the admin-only
`GET /v1/brands/{id}/portal/auth`; ordinary brand reads expose only the mode.

An OIDC configuration supplies an HTTPS issuer, client ID and write-only client secret.
Saving loads bounded discovery metadata through the public-address guarded HTTP client,
refuses redirects, checks the exact issuer, and validates the authorization, token and
JWKS HTTPS endpoints. Secrets are sealed with `d.Box`, included in credential-key rotation,
and never included in responses, events or audit metadata. Omitting a secret preserves
it only for the same issuer and client ID. Selecting `local` clears the provider settings.
Configuration changes are audited; configuration events go to admins only.

External identities belong to a workspace and contact, keyed uniquely by
`(workspace_id, issuer, subject)`, with the originating brand recorded. A revoked link
retains that key as a tombstone. Email matching cannot transfer an identity between
contacts. A contact's `customer_oidc_relink_required` state prevents normal first-time
email matching from bypassing administrative recovery. Contact deletion removes its
identity data, and workspace deletion removes all workspace identity data. Brand deletion
clears only the optional originating brand reference: active ownership and revoked
tombstones remain workspace-scoped, so another brand cannot remap the subject. Brand
configuration and brand-bound relink authorizations are removed with the brand.

An admin with a recent user sign-in and MFA when enabled can authorize one relink through
`POST /v1/brands/{id}/portal/relink-authorizations` with `contact_id`. The server checks
both workspace boundaries and rejects blocked contacts. The authorization expires in
15 minutes; creating another revokes the previous unused authorization for that brand
and contact. It is server-side permission, not a bearer credential. The callback must
consume it atomically with a link only after verifying the provider email matches the
contact's current email. The actor and target are audited without credentials.

## Provider sign-in

A brand in `oidc` or `local_and_oidc` mode signs customers in through its provider.
`GET .../portal/sso/start` redirects to the provider with an authorization code request
(PKCE S256, a nonce and a signed `oauth_state` token that names the brand), and sets a
short-lived cookie scoped to that brand's sso routes. `GET .../portal/sso/callback` accepts a
result only with that state, that cookie, the brand's own redirect URI and an ID token whose
signature, issuer, audience, expiry and nonce check out; the provider is reached through the
public-address guarded client. Where the customer returns to is a path under `/portal/{slug}`
chosen at start; any other value is the portal's home. A failure sends the customer back to the
portal with `?sso_error={code}`; codes carry no provider claims.

Matching, in order:

1. A live `(issuer, subject)` link wins, whatever address the provider now reports.
2. A revoked link refuses (`identity_revoked`).
3. A first sign-in needs a verified address (`email_unverified`) and finds the contact by it.
   A contact with no link of that issuer is linked. A contact marked
   `customer_oidc_relink_required`, or already linked to another subject of the issuer, needs
   a live relink authorization for the brand and contact, consumed in the same transaction
   (`relink_required` without one); the replaced link is revoked.
4. No contact: refused (`unknown_customer`), or created from the verified address and name when
   the brand's `create_contacts` is on (off by default).
5. A blocked contact never signs in (`blocked`).

A provider sign-in opens a `customer_sessions` row with `method = 'oidc'` and no password row;
the session, refresh cookie and access token are otherwise the password sign-in's. A changed
address or a block removes the contact's sessions and live links, and a contact that lost a
link is marked `customer_oidc_relink_required`: its next provider sign-in, the same subject
included, needs a relink authorization, which clears the mark. An `oidc` session needs its
brand to still take a provider: switching it to `local` ends it at the next refresh. A brand in
`oidc` mode refuses password sign-in, password links and resets. Audit events:
`customer.sso.login`, `customer.sso.login.failed` (reason code only), `customer.sso.linked`.

## Starting a request

`POST /v1/customer/portal/tickets` with `{workspace_slug, subject, body}` opens a ticket for the signed-in
customer. The workspace and the customer are the session's own, and the body has no place for either;
`workspace_slug` only names the portal's brand and must be a help center of that workspace. The ticket is
`Channel: portal` on that brand. The subject is trimmed with its spaces collapsed (1..200 characters), the body
is plain text (1..10000, converted to HTML as a portal reply is). The words are written through
`domain.AddMessage` as an inbound contact reply, so ticket events and the `ticket_created` trigger run as for any
ticket, and routing (`routing.Resolve`, channel `portal`) puts it in a team. The customer sets nothing else:
status, priority, severity, team, assignee, labels and fields are the team's. A blocked customer or a suspended
workspace is refused by the same session checks as every portal route, and the contact row is locked while the
ticket is written. A customer starts at most 10 requests an hour, counted for the whole instance (`429`).
The answer is the same `CustomerTicket` the list returns.

### Files

`POST /v1/customer/portal/attachments` (multipart, field `file`) stores one file for the signed-in customer and
answers `201` with the attachment (`id`, `filename`, `content_type`, `size_bytes`, `url`). It is an unattached
upload of that contact, as the widget's is: only they can attach it, once, to a request. Programs and scripts are
refused (`422 file_type_refused`) and active types are stored as plain text, as for every upload; a file over
10 MB is `413`, an empty one `422`; a customer uploads at most 30 files an hour, counted for the whole instance.
`POST /v1/customer/portal/tickets` takes `attachment_ids` (at most 5, `422 too_many_files`); a file that is not the
customer's own unsent upload is `422`, and another customer's file is never read. The files go on the first message.
`CustomerMessage` carries `attachments: [{id, filename, content_type, size_bytes, url}]` for the public replies the
customer reads (never inline pictures of an email's layout, a deleted or purged message's files, or a note's).
`url` is a link signed for one to two hours, like every attachment link, so an image can show in the page; reading
the conversation again signs a fresh one. Replies take no files.


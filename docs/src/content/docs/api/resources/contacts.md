---
title: Contacts and companies
description: Manage the people who write in and the companies they belong to.
---

Scopes: `contacts:read` to read, `contacts:write` to change.

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/v1/contacts` | List contacts. Filters: `q`, `company_id` (`none` for people without a company), `tag`, `blocked`, `field.<key>`. `sort`: `-created` (default), `created`, `name`, `-name`, `-tickets`, `tickets`, `-updated`, `updated` |
| `POST` | `/v1/contacts` | Create a contact |
| `GET` | `/v1/contacts/{id}` | Get a contact |
| `PATCH` | `/v1/contacts/{id}` | Update a contact |
| `DELETE` | `/v1/contacts/{id}` | Delete a contact |
| `GET` | `/v1/contacts/{id}/tickets` | The contact's tickets |
| `POST` | `/v1/contacts/bulk` | Label, set a custom field or the company of, or delete many contacts: `ids` (up to 100) or `query` (the list's filters, at most 1000 contacts), with `patch` or `delete: true` |
| `GET` | `/v1/contacts/{id}/portal` | The contact's customer portal access: `status` (`none`, `invited`, `active`), the last sign-in and the brands an invitation can come from |
| `POST` | `/v1/contacts/{id}/portal/invite` | Email the contact a 7-day link to choose a portal password, from `brand_id` or the default brand |
| `POST` | `/v1/contacts/portal/invite` | Invite up to 100 contacts by `ids`; answers `{sent, skipped}` with the skipped counted by reason |
| `DELETE` | `/v1/contacts/{id}/portal` | Remove the portal password, sign out portal sessions and close open links |
| `GET`, `POST` | `/v1/companies` | List or create companies. Filters: `q`, `tag`, `field.<key>`. `sort`: `name` (default), `-name`, `created`, `-created`, `contacts`, `-contacts`, `-updated`, `updated` |
| `GET`, `PATCH`, `DELETE` | `/v1/companies/{id}` | Get, update or delete a company |
| `POST` | `/v1/companies/bulk` | Label, set a custom field of, or delete many companies, by `ids` or `query` (`q`, `tag`, `fields`) |

## Objects

```ts
type Contact = {
  id: string;
  email: string | null;
  emails: string[];            // extra addresses beside the primary email
  name: string;
  phone: string;
  avatar_url: string;
  company: { id: string; name: string; domain: string } | null;
  external_id: string | null;
  notes: string;
  custom: Record<string, unknown>;
  tags: { id: string; name: string; color: LabelColor; group_id: string | null }[];
  fields: Record<string, FieldValue>;
  blocked: boolean;
  ticket_count: number;
  created_at: string;
  updated_at: string;
};

type Company = {
  id: string;
  name: string;
  domain: string;
  external_id: string | null;
  notes: string;
  custom: Record<string, unknown>;
  tags: { id: string; name: string; color: LabelColor; group_id: string | null }[];
  fields: Record<string, FieldValue>;
  contact_count: number;
  created_at: string;
  updated_at: string;
};
```

A contact's email is unique within the workspace, and so is its `external_id`, your own id for the person (set by [verified widget sessions](/guides/live-chat/identity-verification/)). A company's domain is unique within the workspace, and so is its `external_id`, your own id for the account. Set it so [verified widget sessions](/guides/live-chat/identity-verification/#send-the-users-company-and-attributes) can link people to the company; `null` clears it.

## Sorting and paging

Every sort pages by key: `next_cursor` holds the last record's value and id, so a record added or deleted while you read the list neither repeats nor skips another. A cursor belongs to the sort it came from; sending it with another sort is `400`. Names sort without regard to case, and records with the same value come in id order.

## Many at once

`POST /v1/contacts/bulk` and `POST /v1/companies/bulk` name their records with `ids` (1 to 100) or with `query`, the list's filters as a body (`q`, `tag`, `fields` as `[{ "key", "op", "value" }]`, and for contacts `company_id` and `blocked`), which acts on at most 1000 records. They take `delete: true` or a `patch`: `add_tags`, `remove_tags`, `fields` (merged, `null` clears a field) and, for contacts, `company_id` (`null` clears it). The answer is `{ "updated": n, "deleted": n }`.

A request is all or nothing: an id of another workspace (`404`), a company of another workspace or a value a field refuses (`422`) changes no record. Each record is audited and announced as a single write is. Deleting a contact keeps its tickets, without a contact; deleting a company keeps its people, without a company.

```bash
curl -X POST https://api.opendesk.sh/v1/contacts/bulk \
  -H "Authorization: Bearer od_live_..." -H "Content-Type: application/json" \
  -d '{ "query": { "tag": "trial", "fields": [{ "key": "plan", "op": "not_set", "value": "" }] }, "patch": { "fields": { "plan": "free" } } }'
```

## Several email addresses

A person who writes from more than one address stays one contact. Besides the primary `email`, a contact has extra addresses in `emails`. Mail from any of them lands on the contact, and a search finds it by any. An address belongs to one contact, primary or extra: adding one that another contact (or this one) already has is `409`.

| Method | Path | |
| --- | --- | --- |
| `POST` | `/v1/contacts/{id}/emails` | `{ "email": "..." }` adds an extra address (`201`, at most 20) |
| `DELETE` | `/v1/contacts/{id}/emails/{email}` | takes an extra address off (the primary changes with `PATCH`) |
| `POST` | `/v1/contacts/{id}/emails/{email}/make-primary` | swaps an extra address with the primary; the old primary becomes an extra |

Each answers with the contact. Blocking a contact blocks every address. Customer-portal sign-in uses the primary address only, so making another address the primary ends the contact's portal sessions.

## Merge two contacts

`POST /v1/contacts/{id}/merge` with `{ "into": "<contact id>" }` merges the contact in the path into another one (admin role). The contact in the path is removed, and its tickets, messages, calls, labels and email addresses move to the one that stays; its addresses become extra addresses there, and its chat widget sessions end. The contact that stays keeps its own name, phone, company, external id and primary email, takes the other's where it has none, joins the notes, and merges `custom` and `fields` with its own values winning. It answers with the contact that stays.

A blocked and a not blocked contact (`422`), two contacts with different `external_id` values (`409`), and a result with more than 20 extra addresses (`422`) are refused. A merge cannot be undone.

Writes to contacts and companies take `tags` (replaces), `add_tags`, `remove_tags` and `fields` (merged, `null` clears), with the same rules as tickets. See [Labels and custom fields](/api/resources/labels-fields/).

## Examples

```sh
# Search
curl "https://api.opendesk.sh/v1/contacts?q=ana" -H "Authorization: Bearer od_live_..."

# Create
curl https://api.opendesk.sh/v1/contacts \
  -H "Authorization: Bearer od_live_..." \
  -H "Content-Type: application/json" \
  -d '{ "email": "ana@example.com", "name": "Ana Silva", "custom": { "plan": "pro" } }'

# Block
curl -X PATCH https://api.opendesk.sh/v1/contacts/0192f0c4-... \
  -H "Authorization: Bearer od_live_..." \
  -H "Content-Type: application/json" \
  -d '{ "blocked": true }'
```

## Events

`contact.created`, `contact.updated`, `contact.deleted`, and the same for `company.*`.

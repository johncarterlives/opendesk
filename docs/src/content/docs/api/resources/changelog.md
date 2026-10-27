---
title: Changelog
description: Create, schedule and publish changelog entries, the product updates your help center shows.
---

Scopes: `changelog:read` to read (including drafts and scheduled entries), `changelog:write` to change. Signed-in members of any role read; agents and above write.

| Method | Path | Description |
| --- | --- | --- |
| `GET`, `POST` | `/v1/changelog/entries` | List or create entries |
| `GET`, `PATCH`, `DELETE` | `/v1/changelog/entries/{id}` | |
| `GET` | `/v1/changelog/categories` | The categories in use, `{ name, count }[]`, most used first |

For the public, unauthenticated changelog endpoints, see [Public help center and CSAT](/api/resources/public/#changelog). For writing and publishing in the app, see the [Changelog guide](/guides/changelog/).

## Object

```ts
type ChangelogEntry = {
  id: string;
  title: string;           // 1 to 200 characters
  slug: string;            // unique in the workspace
  excerpt: string;         // plain text, up to 300; taken from the body unless written
  body_html: string;       // sanitized rich text, up to 200 KB
  categories: string[];    // up to 5 names, each up to 32 characters
  status: "draft" | "published";
  published_at: string | null;
  author: UserRef | null;
  brand_id: string | null; // null = every brand
  created_at: string;
  updated_at: string;
};
```

- `published_at` is the date the entry carries. It is set the first time the entry is published unless you give one, and it stays when the entry is unpublished, so publishing it again does not move it.
- A published entry dated in the future is **scheduled**: the help center, its feed and sitemap, and the public API show it from that date on.
- `categories` are free names, such as `"New"`, `"Improved"` or `"Fixed"`. Whitespace is collapsed, and a second spelling of a name already on the entry (compared without case) is dropped.
- `brand_id` is the brand whose help center shows the entry, or `null` for every brand. A brand's entries are deleted with it.
- `body_html` is sanitized before storage. Images are [attachments](/api/resources/messages/) you uploaded or `https` URLs.
- Entry slugs are separate from article slugs.

## List entries

`GET /v1/changelog/entries` lists published entries newest first by `published_at`, and drafts by `updated_at`. It is [cursor paginated](/api/pagination/).

| Parameter | Notes |
| --- | --- |
| `status` | `draft`, `published` or `scheduled` (published with a future date) |
| `category` | One category name, matched without case |
| `q` | Search text |
| `brand_id` | A brand id, or `none` for the entries every brand shows |
| `for_brand_id` | What that brand's help center shows: its own entries and those of every brand |
| `limit`, `cursor` | See [Pagination](/api/pagination/) |

```sh
curl "https://api.opendesk.sh/v1/changelog/entries?status=scheduled" \
  -H "Authorization: Bearer od_live_..."
```

## Create an entry

`POST /v1/changelog/entries` takes `{ title, slug?, body_html?, excerpt?, categories?, status?, published_at?, brand_id? }` and answers the entry. New entries are drafts unless `status` is `published`.

```sh
curl https://api.opendesk.sh/v1/changelog/entries \
  -H "Authorization: Bearer od_live_..." \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: release-4.2.0" \
  -d '{
    "title": "Export reports as CSV",
    "body_html": "<p>Every report now has an <strong>Export</strong> button.</p>",
    "categories": ["New"],
    "status": "published"
  }'
```

- The slug is taken from the title unless you send one. A slug already in use answers `409` with code `conflict`.
- `brand_id` must be a brand of the workspace, or `null`.

## Update, publish and schedule

`PATCH /v1/changelog/entries/{id}` takes the same fields as create; send only those you change.

```sh
curl -X PATCH https://api.opendesk.sh/v1/changelog/entries/0192f0c4-... \
  -H "Authorization: Bearer od_live_..." \
  -H "Content-Type: application/json" \
  -d '{ "status": "published", "published_at": "2026-11-03T15:00:00Z" }'
```

- `"status": "published"` publishes the entry; `"status": "draft"` unpublishes it and keeps its date.
- A `published_at` in the future on a published entry schedules it, as in the example above.
- `"published_at": null` clears the date, so the entry is dated when it is next published.

`DELETE /v1/changelog/entries/{id}` removes the entry.

## Categories

```sh
curl https://api.opendesk.sh/v1/changelog/categories \
  -H "Authorization: Bearer od_live_..."
```

```json
[
  { "name": "Fixed", "count": 42 },
  { "name": "Improved", "count": 30 },
  { "name": "New", "count": 18 }
]
```

## Events

`changelog_entry.created` and `changelog_entry.updated` carry `{ changelog_entry }`; `changelog_entry.deleted` carries `{ changelog_entry_id }`. See the [Events catalog](/api/events/).

---
title: Knowledge base
description: Manage help center collections and articles.
---

Scopes: `kb:read` to read (including drafts), `kb:write` to change.

| Method | Path | Description |
| --- | --- | --- |
| `GET`, `POST` | `/v1/kb/collections` | List or create collections |
| `GET`, `PATCH`, `DELETE` | `/v1/kb/collections/{id}` | |
| `GET`, `POST` | `/v1/kb/articles` | List or create articles. Filters: `collection_id`, `status`, `q` |
| `GET`, `PATCH`, `DELETE` | `/v1/kb/articles/{id}` | |
| `POST` | `/v1/kb/articles/from-wiki` | A draft article copied from a wiki page: `page_id`, `title`, `collection_id`, `brand_id`. Also needs `wiki:read`. See [Wiki](/api/resources/wiki/#tickets-and-the-help-center) |

For the public, unauthenticated help center endpoints, see [Public help center and CSAT](/api/resources/public/).

## Objects

```ts
type KbCollection = { id: string; name: string; slug: string; description: string; position: number; article_count: number };

type KbArticle = {
  id: string;
  collection_id: string | null;
  title: string;
  slug: string;
  excerpt: string;
  body_html: string;
  status: "draft" | "published";
  author: UserRef | null;
  views: number;
  published_at: string | null;
  updated_at: string;
  path: string; // its address on a help center: /c/<collection slug>/<slug>, or /a/<slug> in no collection
};
```

An article's `slug` only needs to be unique within its collection. Add `path` to the help center's address to link to an article. When a slug or collection changes, the old address redirects to the new one.

## Publish an article

```sh
curl https://api.opendesk.sh/v1/kb/articles \
  -H "Authorization: Bearer od_live_..." \
  -H "Content-Type: application/json" \
  -d '{
    "collection_id": "0192f0c4-...",
    "title": "Reset your password",
    "slug": "reset-your-password",
    "excerpt": "Get back into your account in a minute.",
    "body_html": "<p>Open the sign-in page and choose <strong>Forgot password</strong>.</p>",
    "status": "published"
  }'
```

`body_html` is sanitized before storage. A slug another article of the same collection uses is refused with `409`.

## Events

`kb_collection.*` and `kb_article.*`.

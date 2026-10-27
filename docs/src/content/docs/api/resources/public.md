---
title: Public help center and CSAT
description: Unauthenticated endpoints for the public help center, its changelog and customer satisfaction ratings.
---

These endpoints need no credentials. They are what the help center and the CSAT page use, and you can use them to build your own.

## Help center

Only published articles are returned. `{workspace_slug}` is the brand's help center slug (the default brand's is the workspace's); a brand whose help center is off answers `404`.

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/v1/public/help/{workspace_slug}` | `{ title, collections, featured }` |
| `GET` | `/v1/public/help/{workspace_slug}/collections/{slug}` | `{ collection, articles }` |
| `GET` | `/v1/public/help/{workspace_slug}/articles/{slug}` | The article; counts a view |
| `GET` | `/v1/public/help/{workspace_slug}/search?q=` | Matching articles |

```sh
curl https://api.opendesk.sh/v1/public/help/example/search?q=password
```

The rendered help center is served at its own address, not under `/v1` ([Help center addresses](/guides/help-center-addresses/)). For a proxy that issues certificates on demand, `GET /v1/public/help-domains/tls?domain=<hostname>` answers `200` when the instance serves a help center on that hostname and `404` otherwise.

## Changelog

Only published entries dated now or earlier are returned: the brand's own and those of every brand. Scheduled entries appear on their date. The author's email is left out.

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/v1/public/help/{workspace_slug}/changelog` | `{ data, next_cursor }`, newest first. `?category=`, `?limit=` (default 20, at most 50), `?cursor=` |
| `GET` | `/v1/public/help/{workspace_slug}/changelog/{slug}` | One entry |

```sh
curl "https://api.opendesk.sh/v1/public/help/example/changelog?category=New&limit=5"
```

Entries are [`ChangelogEntry`](/api/resources/changelog/#object) objects. Use this route to show your latest updates in your own product; see [Changelog](/guides/changelog/#show-updates-in-your-product).

## CSAT

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/v1/public/csat/survey` | The rating request, from `{ token }` |
| `POST` | `/v1/public/csat/rating` | `{ token, score, comment? }` |

The token comes from the link in the rating email. See [CSAT](/guides/csat/).

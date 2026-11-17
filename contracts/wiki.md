# Wiki

The **wiki** is the team's internal documentation: runbooks, policies, escalation steps,
onboarding, how-tos. Pages nest under each other like folders that hold their own text. Schema:
`migrations/000683_wiki.up.sql`. Owners: the API is backend-helpdesk (`internal/helpdesk/wiki`), the
pages are web (`web/src/pages/wiki`).

The wiki is for members only. It is never public and never reaches a customer: no help center,
no widget, no email agent, no knowledge source of the AI agent, no embeddings. The knowledge base
(`/v1/kb/*`) is what customers read. Ollie, the in-app assistant, reads the wiki for the member it
works for; AI clients connected to the MCP server read and write it with the `wiki:*` scopes. The
wiki is on every plan, with the limits below.

## Shapes

```ts
interface WikiNode {           // a page in the tree, without its body
  id: string
  parent_id: string | null     // the page it sits under; null at the top level
  title: string                // 0..200 characters (longer is 422), whitespace folded; "" shows as "Untitled"
  icon: string                 // one emoji (see "Icons"), or ""
  position: number             // order among its siblings: 0, 1, 2... with no gaps
  version: number              // starts at 1, +1 on every change of title, icon or body
  updated_at: string           // the last change of title, icon or body (moves do not count)
  created_by_id: string | null // who created it; null for an API key, or once the person deleted their account
  tags: string[]               // the #tags in its text, lower case, see "Links and tags"
  aliases?: string[]           // other names it goes by, see "Aliases"; left out when none
}

interface WikiRef { id: string; title: string; icon: string }

interface WikiPage extends WikiNode, PageSettings {
  body_html: string            // rich text, see "Body"
  aliases: string[]            // always present on a page, [] when none
  created_by: UserRef | null   // null for an API key, or once the person deleted their account
  updated_by: UserRef | null
  created_at: string
  breadcrumbs: WikiRef[]       // its ancestors, the top-level page first
  children: WikiRef[]          // its subpages, in order
}

interface PageSettings {       // see "Page settings"
  cover: string                // "" (none), "gradient:<name>", or an image: https or /v1/attachments/<id>
  cover_y: number              // 0..100: which part of an image cover shows, top to bottom; default 50
  full_width: boolean
  small_text: boolean
  font: "default" | "serif" | "mono"
  locked: boolean              // the app keeps the page read-only until someone unlocks it
}

interface LinkCard { title: string; description: string; image: string; site: string }

interface WikiRevision {
  id: string
  title: string
  icon: string
  body_html?: string           // only when one revision is read
  author: UserRef | null
  created_at: string           // the first edit it holds
  updated_at: string           // the last edit it holds
}

interface WikiSearchHit {
  id: string
  parent_id: string | null
  title: string
  icon: string
  snippet: string              // plain text around the match, no markup
  path: WikiRef[]              // its ancestors, the top-level page first
  updated_at: string
}
```

## Databases

A page can be a **database** (`kind: "database"`, migration `000723`): it keeps `database` (its properties
and views) and its subpages are its **rows**, each a page with `props`, its values by property id.
Rows open as pages (title, text, history, links) and are left out of the sidebar; the database's views
show them. Create one with `POST /v1/wiki/pages` `{kind: "database", database?}` (left out: a title and
tags in a table); a row with `{parent_id: <database>, title, props}`. `PATCH` takes `database` (replaced
whole, a database only) and `props` (merged; `null` takes a value away; a row only); neither moves the
version or adds a revision, and `wiki_page.updated` carries `database` or `props`. A row's values move
its last edit. `GET /v1/wiki/databases/{id}/rows` answers `{data: DbRow[], templates: WikiNode[]}`:
every row in the tree, in order, with `props`, `cover`, `excerpt` (how its text starts), who made and
last edited it; and the database's own templates (pages made with `{parent_id: <database>, template:
true}`), which a new row can start as a copy of. Wrong shapes are `422 invalid_database`.

```ts
interface Database {
  properties: DbProperty[]
  views: DbView[]
  next_id: number
  sub_items?: { parent: string; children: string }          // two relation property ids (see below)
  dependencies?: { blocked_by: string; blocking: string }   // two relation property ids (see below)
}
interface DbProperty {
  id: string            // [a-z0-9_]{1,24}; the first property is the title ("title"), the only one
  name: string          // 1..100
  type: "title" | "text" | "number" | "select" | "multi_select" | "status" | "date" | "person" | "checkbox"
      | "url" | "email" | "phone" | "files" | "relation" | "rollup" | "formula" | "created_time"
      | "created_by" | "edited_time" | "edited_by" | "unique_id" | "ticket"
  options?: { id: string; name: string; color: Tone }[]   // select, multi_select, status (200 at most)
  groups?: { id: "todo" | "doing" | "done"; option_ids: string[] }[]   // status
  number_format?: "number" | "comma" | "percent" | "usd" | "eur" | "gbp" | "jpy" | "chf" | "cad" | "aud" | "inr" | "brl" | "huf" | "pln"
  date_time?: boolean   // date values have a time of day
  database_id?: string  // relation: the related database
  rollup?: { relation: string; property: string; fn: RollupFn }   // the relation property, a property of the related rows
  formula?: string      // the app's formula language (prop("Name"), if, concat, dateBetween, ...)
  prefix?: string       // unique_id: letters before the number
  description?: string
}
interface DbView { id: string; name: string; type: "table" | "board" | "list" | "gallery" | "calendar" | "timeline" | "chart" | "form"; settings?: object }
```

| type | stored value |
| --- | --- |
| text, url (http or https), email, phone | string |
| number | number |
| checkbox | boolean |
| select, status | an option id |
| multi_select | option ids |
| date | `{start, end?}`: `YYYY-MM-DD` or RFC 3339 |
| person | user ids of the workspace's members |
| relation | page ids of live rows of the related database the caller may see |
| ticket | ticket ids of the workspace the caller may see |
| files | `[{url, name}]`: https or our attachments |
| title, rollup, formula, created/edited time and by | computed by the app, never stored |
| unique_id | numbered by the API: each new row, and the rows there when the property is added (oldest first) |

At most 100 properties, 50 views, 128 KB of schema and 64 KB of values per row. A view's `settings`
belong to the app (`web/src/lib/api/types.ts` `DbViewSettings`): filters (rules in and/or groups),
sorts, the property it groups by, the properties shown and their order and widths, the calendar's and
timeline's date properties, card previews, chart settings, column calculations and a form's questions. Filtering, sorting,
grouping, formulas, rollups and calculations run in the app (`web/src/lib/wiki/db`).

A **form** view (`type: "form"`) asks for a new row. Its `settings.form` is `{title?, description?, fields:
[{property, required?, help?}], submitted?}`: the properties it asks in order (stored types only), whether
each must be answered, a hint under each, and what it says once sent. The title is always asked first and
always required. Sending it creates a row like any other (`POST /v1/wiki/pages`), so only members who can
write rows (agents and up) send it; viewers read it. Forms are for members only, never public. The
database's page opens on a view with `?view=<view id>`, the link a form is shared by.

**Sub-items** and **dependencies** each pair two relation properties of a database to itself, named by
`sub_items` (`parent`, `children`) and `dependencies` (`blocked_by`, `blocking`): two different relation
properties of the schema with the same `database_id` (the database itself), no property in both pairs. A
row's `parent` names one row at most; `422 invalid_database` otherwise. The API checks each value as a
relation and writes only the row it is given: **the app keeps the two sides in step**, writing the other
side on each row a change adds or removes (`pairedWrites` in `web/src/lib/wiki/db/pairs.ts`; a row moved
under a new parent leaves its old one's `children`; a parent is never the row itself or one of its
sub-items). Turning either off removes the pair from the schema and leaves both properties as plain
relations. Tables and lists nest sub-items under their parent with a disclosure (filters and sorts apply
within each level; a row whose parent is filtered out shows at the top); boards, galleries, calendars and
charts show every row flat. The timeline draws an arrow from each blocking row to the row it blocks, red
with the blocked row marked when it starts before its blocker ends; the row's page says so under
"Blocked by".

A page holds a database with the block `<div data-type="database" data-id="<database id>" data-view="<view id>">`:
the database's view inside the page, with its controls. "/table", "/board", "/list", "/gallery", "/calendar"
and "/timeline" make a database under the page and show it there; "Linked view of a database" shows one
that exists. Duplicating a database copies its rows; a row copied into a database gets a new unique id.

## Canvas

A page can be a **canvas** (`kind: "canvas"`, migration `000726`): cards on an endless board and the
connections between them, the shape of [JSON Canvas 1.0](https://jsoncanvas.org) with the wiki's own
card types. It keeps `canvas`; its `body_html` is its description (empty from the app) and its subpages
are pages as anywhere else. Create one with `POST /v1/wiki/pages` `{kind: "canvas", canvas?}` (left out:
an empty canvas). `PATCH` takes `canvas` (a canvas only), replaced whole: like a database's schema it
keeps the version and adds no revision, and the last save wins; it does move the page's last edit, and
`wiki_page.updated` carries `canvas` (or `canvas_changed: true` when the canvas is over 256 KB: read the
page). The app takes it when it has nothing unsaved and no drag under way. Wrong shapes are
`422 invalid_canvas`. Duplicate, templates, the trash and restore carry it like the rest of the page; a
copy's page cards that show pages copied with it show the copies.

```ts
interface Canvas { nodes: CanvasNode[]; edges: CanvasEdge[] }   // nodes in z order, later above
interface CanvasNodeBase {
  id: string                  // [A-Za-z0-9_-]{1,64}, unique among the nodes
  x: number; y: number        // finite, within ±1,000,000
  width: number; height: number   // 20..20,000
  color?: string              // "1".."6" (red, orange, yellow, green, cyan, purple) or "#rrggbb"
}
type CanvasNode = CanvasNodeBase & (
  | { type: "text"; html: string }       // wiki HTML, sanitized like a body (hd.SanitizeWiki)
  | { type: "page"; page_id: string }    // a page of the workspace
  | { type: "link"; url: string; title?: string; description?: string; image?: string }   // https; the card from POST /v1/wiki/unfurl
  | { type: "file"; src: string; name: string }   // one of our attachments (/v1/attachments/<id>) or https; name up to 255
  | { type: "group"; label?: string }    // label up to 200
)
interface CanvasEdge {
  id: string                  // as a node's, unique among the edges
  fromNode: string; toNode: string       // nodes of the canvas
  fromSide?: "top" | "right" | "bottom" | "left"; toSide?: same   // left out: the sides that face each other
  fromEnd?: "none" | "arrow"  // default none
  toEnd?: "none" | "arrow"    // default arrow
  color?: string; label?: string         // label up to 200
}
```

- At most 2,000 nodes, 4,000 edges and 1 MB. Fields that don't belong to a node's type are dropped,
  labels and titles have their whitespace folded, and the default ends are left out.
- A page card added by a save names a page of the workspace the caller may see (not in the trash); a
  file card added by a save names an attachment of the workspace. Cards already on the canvas stay as
  they are, so a teammate saves a canvas holding a page they can't see. Reading a canvas never shows a
  page's title: the app draws a page card from the reader's own tree, and "A page you can't see" for a
  page out of their sight or deleted.
- The cards count as the page's text: page cards and the page links in text cards are its links
  (backlinks, the graph), `#tags` and ticket mentions in text cards are its tags and ticket links, and
  the words on the cards (text, labels, link titles and descriptions, file names, connection labels) are
  searched (`wiki_pages.canvas_text`, kept by the API). Mentions of people and dates in text cards
  notify and remind nobody.
- Import and export ("Import and export") read and write a canvas as a JSON Canvas `.canvas` file, as
  Obsidian keeps one (`internal/helpdesk/wikiport/canvas.go`, whose `Canvas` is this shape). Out: text
  cards in Markdown (`internal/helpdesk/wikiconv`, page links as `[[links]]`), page cards as `file` nodes
  naming the exported page's file, files the export carries as `file` nodes under `attachments/`, https
  files and link cards as `link` nodes, groups (`label`) and connections as they are. A page or file the
  export doesn't carry is a `link` node to the app, or an empty text node without the app's address. In:
  the reverse, with JSON Canvas's own colours (`"1"`..`"6"` and hex) kept; a link card's title,
  description and picture, and a canvas page's icon and `body_html`, have no place in the file. An HTML export draws the
  canvas in its page: the cards where they sit, groups below the connections, connections as lines.

The app (`web/src/components/wiki/canvas`) pans (drag empty space, Space and drag, scroll, arrow keys)
and zooms (Ctrl or Cmd and scroll, pinch, +/−, Shift+1 fits, Shift+2 fits the selection); selects with a
click, Shift and click, or Shift and drag; moves cards on a 20 point grid (Alt for free), resizes,
connects from a card's sides (let go on empty space for a new card there), copies, pastes, duplicates
(Mod+D), groups the selection (Mod+G) and deletes; Mod+Z and Mod+Shift+Z undo and redo this tab's
own changes (cleared when someone else's canvas arrives). A double-click on empty space makes a text
card; on a card it edits its text, renames a group, opens a page beside the canvas, or opens a link or
a file. Viewers pan, zoom and open cards. Pasting a link makes a link card, an image or a file uploads
it, and text makes a text card.

## Private pages and teamspaces

A top-level page lives in a **space**, and every page under it lives there too:

- **workspace** (the default): every member sees it, as before.
- **private**: one member's own (`private_to`). Nobody else sees it, admins and owners included, nor an
  API key; the member's AI client and Ollie, who read as them, do. Deleting their account deletes their
  private pages.
- **team** (a teamspace, `team_id`): a team's pages. A private team's teamspace is its members' alone
  (the same rule as its tickets, contracts/teams.md "Visibility"); a public team's every member sees.
  A team that is deleted leaves its pages in the workspace.

`WikiNode` and `WikiPage` carry `private` and `team_id`. Create and move take `space`
(`workspace | private | team`) and `team_id` for a top-level page; a subpage always lives where its
parent does, and moving a page to another space takes its subpages along. Only its member moves a
private page out of their own. A page out of the caller's sight is `404` everywhere and never shows in
the tree, search, links, the graph, favorites or recent pages; its events go only to its member
(`Users`) or its private team (`TeamID`), else to the workspace. Workspace-wide readers (procedures,
`wiki.WorkspaceViewer`) see neither private pages nor a private team's.

## Trash

`POST /v1/wiki/pages/{id}/trash` moves a page and its subpages to the trash (the same people may as may
delete it; audit `wiki_page.trashed`); they leave the tree, search, links, the graph and favorites, and
`wiki_page.deleted` carries `trashed: true`. A page in the trash still reads, with `deleted_at`,
`deleted_by`; changing, moving or adding under it is `422 page_in_trash`. `GET /v1/wiki/trash` lists the
pages trashed (not those that went with a parent), last first, each with `subpages`, `path` and
`purge_at`. `POST /v1/wiki/pages/{id}/restore` puts it back with what went with it: under its parent
when that is in the tree (and deep enough room), else at the top of its space, last; `422 not_in_trash`,
`422 trashed_with_parent` (restore the page above it); event `wiki_page.restored` `{wiki_page,
wiki_page_ids}`, audit `wiki_page.restored`. After 30 days an hourly job (`wiki.trash_purge`) deletes
them for good. `DELETE /v1/wiki/pages/{id}` still deletes for good, from the tree or the trash, with
everything under it. The app's Delete is Move to trash, with Undo; Delete for good is in the trash.

## Templates

A template is a page (with its subpages) copied into new pages; it stays out of the tree, search, links
and the graph. `GET /v1/wiki/templates` lists those the caller may see. A page is made a template with
`POST /v1/wiki/pages` `{template: true}` (top level) or by copying one.
`POST /v1/wiki/pages/{id}/duplicate` `{parent_id?, space?, team_id?, template?, title?, position?}` copies a
page and its subpages (text, icons, look; links between the copies point at the copies; `201`):
Duplicate, Save as template and Use a template are all this. The app also offers starter templates of
its own (escalation, refunds, onboarding, meeting notes, incident review, how-to, project brief,
decision record, customer call notes, FAQ, weekly sync), made in the reader's language.

## Aliases

A page goes by other names besides its title, as Obsidian's aliases (`wiki_pages.aliases`, migration
`000728`): at most 10, each up to 100 characters with its whitespace folded like a title's; empty ones
and repeats (in any case) are left out, more is `422`. `POST /v1/wiki/pages` takes `aliases`, and
`PATCH` takes them replaced whole (`[]` removes them); like the page's look, changing them keeps the
version and adds no revision, and `wiki_page.updated` carries `aliases`. A copy (Duplicate, a template)
starts without them. They find the page:

- search (`GET /v1/wiki/search`, the command palette) weighs them as its title;
- the editor's `[[` and `@` page search, and the link field of the text toolbar, match them as the
  title (the best match of the two is what ranks it);
- unlinked mentions ("Links and tags") look for each alias as for the title, and the panel's Link links
  the first name the other page has;
- Markdown export writes them in the front matter (`aliases:`), and import reads `aliases` and `alias`
  there (the first 10 it can keep).

The app shows them under the title, small, as "Also called" chips (Add alias beside Add icon and Add
cover; Enter or a comma adds one, Backspace on an empty field takes the last back), and in the page
panel's Info, where editors change them.

## Split view

A second page opens beside the one in the address, as Obsidian's panes: `/wiki/<id>?beside=<id>`, so a
split is a link and survives a reload (`web/src/lib/wiki/split.ts`). It opens from "Open beside" in the
sidebar's page menu, "Open a page beside" in the page's menu (a searchable list, aliases included), and
Alt-click (Option-click) on any link to a page; Mod-click stays the browser's new tab. A link followed
inside the side page opens there. The side page has its own bar (swap the pages, open it as the main
page, close) and is a full page with its own editor and saves, so both are edited at once; its edge
drags to resize it (kept per person in the browser, `lib/panes.ts` `beside`). The main page keeps the
window's title, the header, the page panel (beside the text from 1536 px while a page is beside it) and
comments; presence (contracts/realtime.md) is joined
for the main page only, since a member has one active wiki page. Below 1024 px the side page opens as
a peek over the page.

## Page analytics

`GET /v1/wiki/pages/{id}/analytics?days=28` (viewer, `wiki:read`; a page the caller may see, else `404`;
`days` 1..90) answers how the page was read, per day (UTC), counts only:

```ts
interface WikiPageAnalytics {
  days: { date: string; views: number; viewers: number }[]   // every day of the range, today last
  total_views: number
  total_viewers: number                                       // different people over the range
  edits: { date: string; count: number }[]                    // revisions started each day
}
```

Each read of a page in the tree by a person (`GET /v1/wiki/pages/{id}`, the read that counts a visit)
is a view of that day in `wiki_page_views (page_id, day, user_id, views)` (migration `000728`), except
that reads by the same person less than 30 minutes apart are one view: a page read again as others
save it, an author's own reloads, count once. Days are kept 90 days (the hourly `wiki.trash_purge`
forgets older ones), and go with the page or the person. Who read it is never part of it: the readers
list ("Favorites, recent pages and readers") is the only place names show. The page panel's Info shows
"N views by M people" over the last 28 days, a bar per day (each day on hover and with the arrow keys,
a table for screen readers) and the days it was edited as dots under them.

## Favorites, recent pages and readers

People only (an API key is `403`): `GET`/`PUT /v1/wiki/favorites` `{page_ids}` (at most 100, in order;
pages out of sight or in the trash are left out); `GET /v1/wiki/recent?limit=` (the pages they opened
lately: each read of a page in the tree by a person counts a visit); `GET /v1/wiki/pages/{id}/views`
`{views, people, readers: [{user, visits, last_at}]}` (the latest 20).

## Journal

`POST /v1/wiki/daily` `{date, title, journal_title?, body_html?}` opens the caller's note of that day,
making it (and, the first time, their journal: a private top-level page, `journal`, 📓) when there is
none. Daily notes are private pages under the journal with `daily_date`, newest first; one per day.
`GET /v1/wiki/daily?from=&to=` lists the days that have one. The journal stays at the top of their
private pages (`422 journal_fixed` on a move); a note moved out of it is a page.

## Verified pages

`PATCH` `{verified: true, verified_days?}` verifies a page as the caller (a person; an API key is `403`),
for that many days or until someone changes it; `{verified: false}` takes it away. Like the page's look,
it keeps the version and adds no revision; `wiki_page.updated` carries `verification`. `WikiPage.verification`
is `{by, at, until, expired}` or null, and nodes carry `verified` while it holds. The app shows a check
beside verified pages in the sidebar and "Verified by Maya until 3 March" under the title.

## Sidebar

The wiki's sidebar has sections each member arranges (order, hidden, folded; kept per workspace in the
browser): Favorites, a section per teamspace they see, the workspace's pages, their private pages and
Recent; then today's note, templates, the graph, tags and the trash. Pages drag between sections (a
page dropped at the top level of another space moves to it). A page can also be a row of a Space
(contracts/spaces.md, `wiki_page`), and a teamspace too (`wiki_space`).

## In the main sidebar

Pages, databases and canvases are part of the app, not only the wiki: the main sidebar has a built-in
**Pages** section (`SidebarPrefs` section id `pages`, contracts/collab.md), ordered, hidden and
numbered like the others, while the workspace has Pages on. It shows the tree of Pages' area
(contracts/pages.md "Areas"), live like the wiki's own sidebar (the `wiki_page` events keep it current): the workspace's pages at the top level, each teamspace the member sees under a
row that folds, their private pages under Private, then Today's note, Templates and Trash. Rows nest,
fold, drag and have the wiki's page menu (favorite, add a subpage, duplicate, move, copy a link, open
beside, add to a Space, move to the trash), plus Hide from sidebar on a top-level page or a teamspace.
What shows is the member's (`SidebarPrefs.hidden`): `section:pages` (the whole section),
`pages:<part>` for a part (`workspace`, `teamspaces`, `private`, `today`, `templates`, `trash`),
`wiki_page:<id>` for a top-level page and `wiki_space:<team id>` for a teamspace. The collapsed rail
shows one Pages row to `/pages`. Folded rows are kept per member in the browser.

The member's favorite pages (`/v1/wiki/favorites`, one list) are also rows of the main Favorites, after
its pins, with the page's live title and icon.

Adding happens in place, never by leaving for Settings: the section's `+` and the header's New menu
open the new page popup (where it goes, then a page, a database or a canvas, a template, or files to
import, dropped or picked), and files dropped on the section open the import with them. Viewers see
no `+`. On wide screens the wiki's own page list beside a page shows or hides from the page's header,
remembered in the browser; until the member chooses, it is hidden while the Pages section shows.

## Access

| who | reads | creates, edits, moves, restores | deletes |
| --- | --- | --- | --- |
| viewer | yes | no | no |
| agent | yes | yes | a page they created, when they also created every page under it |
| admin, owner | yes | yes | any page |
| API key, AI client | `wiki:read` | `wiki:write` | `wiki:write` (an AI client's member: as their role allows) |

An agent deleting a page with someone else's page in it (the page or any subpage, including pages
moved under it) gets `403`, with a message saying an admin can delete it; so moving another team's
pages under one's own never makes them deletable. The tree carries `created_by_id` so the app offers
Delete only where it would pass, and says why it doesn't otherwise. An API key with `wiki:write`
deletes any page: whoever holds the key is trusted with the whole wiki.

Every page belongs to one workspace and is read and written with the caller's workspace. A
`parent_id` from another workspace is `422`; another workspace's page is `404`. The parent of a
page is enforced in the schema too (a composite key on `(workspace_id, parent_id)`). `kb:*`
scopes do not reach the wiki, nor `wiki:*` the knowledge base.

## Tree

- New pages go at the end of their parent's subpages unless `position` says where.
- `POST /v1/wiki/pages/{id}/move` `{parent_id, position}` moves a page with everything under it. A
  page never moves under itself or one of its subpages (`422 page_cycle`). Positions are numbered
  again from 0 among the new siblings and, when the parent changed, the old ones.
- Changes to the tree (create, move, delete) of one workspace run one at a time
  (`pg_advisory_xact_lock`), so counts, depths and cycle checks see each other.
- Deleting a page deletes its subpages and their history, for good (`ON DELETE CASCADE`). The app
  asks first and names how many subpages go with it.
- In the app, pages drag onto, above and below each other; **Move to…** in a page's menu (in the tree
  and on the page) picks the new parent from a searchable list, or the top level, and puts the page
  last among its new siblings. It is what touch screens use, where dragging is not available. Pages
  the move can't go under (the page itself, its subpages, or past the depth limit) are not offered.

## Body

`body_html` is sanitized before it is stored with `hd.SanitizeWiki`: the rich-text allowlist the
knowledge base uses (`hd.SanitizeRich`: paragraphs, headings, lists, quotes, code, links, images from
https or our attachments, mentions) and the wiki's blocks below. Pages written before the blocks
existed are valid as they are. The knowledge base keeps its own allowlist: no block reaches an article.
Images and files are uploaded as attachments (`POST /v1/attachments`) and become the page's own as
it is saved (see "Files").
People are mentioned with `<span data-type="mention" data-id="<user id>">`, tickets and contacts with a
link of their kind (see "Desk"); a run of text an inline
comment is on is `<span data-comment="<thread id>">`, and a date that reminds someone carries
`data-reminder="<uuid>"` (see "Comments", "Reminders").

## Files

A body names one of our files as `/v1/attachments/<id>` (in `src`, `data-src` or `href`). The API
stores that plain path: a link to the file at the API's address, signed or not, is stored as its path.
As a page is saved (created, edited, restored, copied from a template, imported), each upload it
names that the person or key saving it uploaded, and that no message, page, article or changelog
entry holds yet, becomes the
page's own (`attachments.wiki_page_id`, migration `000727`, which also gave pages written before the
uploads they name). A page's files:

- are kept while the page is, in the trash too; the sweep of uploads nobody sent leaves them. A page
  deleted for good lets go of them, and the sweep removes them a day later;
- are read by whoever may see the page (`GET /v1/attachments/{id}`: a member, or an API key with
  `wiki:read`; "Private pages and teamspaces");
- come signed in a page read: `GET /v1/wiki/pages/{id}` (and every route answering a `WikiPage`)
  gives each file of the page's space (held by that page or another page of the same space), and
  each file a knowledge base article or changelog entry of the workspace holds (any member reads
  those; contracts/api.md "Article and changelog files"), as a signed link valid for one to two
  hours, so `<img>` loads without a token. Any other file keeps its plain path.

## Blocks

The app writes pages with a block editor (`web/src/components/wiki/editor`): "/" offers every block,
"[[" links a page, "@" mentions a person, a page, a date, a ticket or a contact, "#" a ticket, ":" an emoji; a handle beside each block
drags it or opens its menu (turn into, colour, duplicate, copy a link to it, move, delete), and a
toolbar shows over selected text. The page's formatting bar stays available (page menu, "Formatting
bar", kept per browser). Every block is a plain element with data attributes, each value checked:

| block | HTML |
| --- | --- |
| headings 1 to 3, paragraph | `h1`..`h3`, `p`; `style="text-align: left\|center\|right\|justify"` |
| block colour | `data-color` (text) and `data-bg` (background) on `p`, `h1`..`h3`, `li`, lists, `blockquote`, `details`: `gray`, `brown`, `orange`, `yellow`, `green`, `blue`, `purple`, `pink`, `red` |
| inline colour | `<span data-color>`, `<mark data-bg>` (same tones) |
| to-do list | `<ul data-type="taskList"><li data-type="taskItem" data-checked="true\|false">`; the checkbox is the app's to draw, never stored |
| toggle | `<details><summary>…</summary><div data-type="detailsContent">…</div></details>` |
| toggle heading | the toggle with `data-heading="1\|2\|3"`: its summary is a heading of that level, folding what is under it ("/toggle heading 1" to 3); exports write it as a heading |
| callout | `<div data-type="callout" data-icon="<emoji>" data-tone="<tone>">blocks</div>` |
| columns | `<div data-type="columns">` holding 2 to 5 `<div data-type="column">` |
| code | `<pre><code class="language-<name>">`; the app highlights it. In `mermaid` it is a diagram: the app draws it (the `mermaid` library, loaded when a page has one, `securityLevel: "strict"`, the reader's light or dark theme) with its source a toggle away |
| equation | `<div data-type="block-math" data-latex>`, `<span data-type="inline-math" data-latex>`; KaTeX in the app |
| image | `<img src alt data-width="1..100" data-align="left\|right" data-caption>` (width in percent of the column) |
| file, video, audio | `<div data-type="file\|video\|audio" data-src data-name data-size data-mime>`; `data-src` is https or one of our attachments |
| bookmark | `<div data-type="bookmark" data-url data-title data-description data-image>` (https links), see "Bookmarks" |
| embed | `<div data-type="embed" data-url>`, see "Embeds" |
| table of contents | `<div data-type="toc">`: the app lists the page's headings |
| subpage | `<div data-type="subpage" data-id="<page id>">`: the page shows where it sits in the text |
| synced block | `<div data-type="transclusion" data-id="<page id>" data-block="<block id>">`: another page, or with `data-block` one block of it (a heading: the heading and what follows up to the next heading of its level or higher; a toggle heading counts as one), shown live and read-only with its title and "Edit original", as Notion's synced blocks and Obsidian's `![[Note#Heading]]`. "/synced block" or "![[" picks the page and then, optionally, a heading of it; a copied block link pasted on an empty line makes one. A page the reader can't see shows a stub without its title; an embed of the page itself, a loop through other embeds, or more than 3 inside each other shows "can't show this here". Markdown exports write `![[Note]]`; an article leaves it out (`left_out`) |
| button | `<div data-type="button" data-label="<1..100 characters>" data-action="template\|todo\|link\|row">` with what the action needs: `data-template="<template page id>"` (its blocks go under the button, with new block, footnote and reminder ids and no comment marks), `data-title` (the to-do's text, or the new row's title), `data-url` (https, opened in a new tab; the only action a reader who can't edit may use), `data-database="<database id>"` and `data-props` (one JSON object of at most 1,000 characters: the new row's values by property id, for text, url, email, phone, number, checkbox, select and status properties; values that no longer fit the database are left out) |
| link to a page | `<a data-type="page" data-id="<page id>" data-block="<block id>" href="/wiki/<id>">title when linked</a>`; the app shows the page's live title and icon |
| ticket, contact | `<a data-type="ticket" data-id="<ticket id>" href="/tickets/<number>">`, `<a data-type="contact" data-id="<contact id>" href="/contacts/<contact id>">`; drawn live, see "Desk" |
| ticket list | `<div data-type="tickets" data-id="<saved view id>" data-limit="<number>">`: the view's open tickets, see "Desk" |
| date | `<time data-type="date" datetime="YYYY-MM-DD">`, or with a time `YYYY-MM-DDTHH:MM` (the writer's clock) or RFC 3339; `data-reminder="<uuid>"` makes it a reminder (see "Reminders") |
| inline comment | `<span data-comment="<thread id>">commented text</span>`: the run of text a thread is on (see "Comments") |
| footnote | `<sup data-type="footnote" data-note="<uuid>">n</sup>` in the text, and the notes in one list at the page's end: `<div data-type="footnotes">` of `<div data-type="footnote" data-note="<uuid>">` holding paragraphs. Numbered by where each note is first referenced (`n` is the number when saved); the app keeps the list in that order, adds a note for a new reference and drops the notes nothing references, in the same edit. "/footnote" or typing `[^` adds one; a reference shows its note on hover. A `<sup>` without both attributes is a plain superscript. Exports write `[^n]` and `[^n]: note`; an article `[n]` and a paragraph per note |
| table | `table`, `colgroup`/`col` (`style` width or min-width in px), `th`/`td` (`colspan`, `rowspan`, `colwidth`) |
| divider | `hr` |

Blocks carry `data-block-id` (a uuid) so a link can point at one (`/wiki/<id>#<block id>`), or a synced block show it. The app adds
ids as a page loads without saving them: loading is never an edit, and the next save carries them.
"Copy link to block" saves first. Nothing runs, loads a frame or styles freely: no `iframe`, `script`,
`style` element or event handler survives, and a value that doesn't match is dropped.

**Print or save as PDF** (the page menu, or Mod+P in the editor; `web/src/components/wiki/editor/print.ts`)
prints a copy of the page alone: its cover, icon, title and text, in the light theme, toggles open, without the
app around it or the editor's controls (anything marked `data-print="hide"`).

## Embeds

An embed keeps only the link that was pasted. The app maps it to the provider's own player
(`web/src/lib/wiki/embeds.ts`: YouTube, Vimeo, Loom, Figma, Google Docs, Sheets, Slides, Forms and
Drive, Google Maps, Miro, CodePen, CodeSandbox, Spotify, Excalidraw, Airtable, Typeform, Calendly) and
loads it in a sandboxed frame. Those players' origins are the only frames the app's
Content-Security-Policy allows besides Turnstile (`internal/app/app.go`, `deploy/cloudflare/pages/app/_headers`;
`TestEmbedFrameSourcesAgree` keeps the three lists equal). A link no provider plays shows as a link.

## Bookmarks

`POST /v1/wiki/unfurl` `{url}` (agent, `wiki:write`; 120 a minute per workspace) reads an https page
once, through the outbound guard (no private, loopback or link-local targets; redirects re-checked; 512 KB
of HTML at most), and answers a `LinkCard` from its Open Graph tags, else its `<title>` and description.
A page it can't read is `422 unreachable`; the app then keeps the bookmark with its address alone. The
card is stored in the block: nothing is fetched when the page is read later.

## Page settings

A page's cover, width, text size, font and lock are its look, not its text. `PATCH` takes any of
`cover`, `cover_y`, `full_width`, `small_text`, `font`, `locked` without a `version`: changing them keeps
the version (a tab typing on the page never conflicts with it) and adds no revision. A cover is ""
(none), one of the app's gradients (`gradient:` `dawn`, `ocean`, `forest`, `dusk`, `sand`, `slate`, `rose`,
`lagoon`, `aurora`, `ember`; `web/src/components/wiki/covers.ts`), or an image: https or an attachment.
Anything else is `422`. A locked page opens read-only in the app for everyone, with Unlock for people
who may edit; the API does not refuse edits to it (it guards against accidents, not people). Viewers
change nothing.

## Editing together

The app saves as people type. Every PATCH from the app sends the `version` it edited; when someone
else saved since, the API answers `409 page_changed` and changes nothing. The app then shows
"Someone else edited this page", keeps what was typed and offers to load their version or to keep
its own (which saves again with the new version). A PATCH without `version` (an API caller that
does not care) always applies. A PATCH that changes nothing keeps the version and publishes no
event.

Only a person who may edit ever saves, and loading a version (someone else's, a restored one,
theirs after a conflict) is never an edit: viewers and idle agents send nothing. A save answered
`403` or `404` stops for good (no retries): the page says it can't be edited or was deleted, and
offers the unsent text to copy. While any page holds unsent text, closing the tab from anywhere in
the app sends it and the browser asks first. A tab refetches a page when an event's `version` is
newer than the one it holds, so the same person's edits from another tab or through Ollie arrive
too.

## History

Every change of title, icon or body is kept as a revision:

- One person's edits less than 10 minutes apart, for at most an hour, are one revision: while they
  type, their latest revision moves along (`updated_at`). Someone else's edit, a pause, an API key's
  edit and a restore start a new one.
- At most 100 revisions per page are kept; the oldest go first.
- Restoring a revision puts its title, icon and body back as a new version and a new revision, so
  what it replaced stays in the history.

Moves are not revisions.

## Comments

Members discuss a page in threads beside it. A thread is its first comment and the replies under it,
oldest first; it is either on the page as a whole or **inline**, on a run of the text: the app marks
that run in the body with `<span data-comment="<thread id>">` and keeps the text it was made on as
`quote`. A mark whose thread was deleted is harmless; the app highlights only open threads. Schema:
`migrations/000724_wiki_collab.up.sql`.

```ts
type WikiReaction = { emoji: string; users: string[] }                // user ids, oldest first
type WikiComment = { id: string; thread_id: string; author: UserRef | null; body_html: string; mentions: string[];
  created_at: string; edited_at: string | null; reactions: WikiReaction[] }
type WikiThread = { id: string; page_id: string; quote: string; inline: boolean; created_at: string;
  resolved_at: string | null; resolved_by: UserRef | null; comments: WikiComment[] }   // comments oldest first
type WikiComments = { data: WikiThread[]; following: boolean }        // threads oldest first
```

| method | path | | |
| --- | --- | --- | --- |
| GET | `/v1/wiki/pages/{id}/comments` | `wiki:read` | `WikiComments`: open and resolved threads (the app filters), and whether the caller follows the page |
| POST | `/v1/wiki/pages/{id}/comments` | `wiki:write` | `{body_html, mentions?, thread_id?, quote?, inline?}` → `201 WikiThread`: a new thread, or a reply with `thread_id` (a thread of this page, else `422`); a reply reopens a resolved thread |
| PATCH | `/v1/wiki/comments/{id}` | `wiki:write` | `{body_html, mentions?}` → `WikiThread`; its author only (`403`), sets `edited_at` |
| DELETE | `/v1/wiki/comments/{id}` | `wiki:write` | `204`; its author or an admin (`403`). Deleting a thread's first comment deletes the thread; notifications about what was deleted go with it |
| POST | `/v1/wiki/threads/{id}/resolve` | `wiki:write` | `{resolved}` → `WikiThread` (`resolved_by` is who resolved it) |
| POST | `/v1/wiki/comments/{id}/reactions` | `wiki:write` | `{emoji, on}` → `WikiThread`: one emoji (as page icons, `422` otherwise), once per person |

- A comment's body is sanitized like a note (`hd.SanitizeRich`, up to 20,000 characters); one with no
  text and no mention is `422`. `mentions` are the members it mentions: the ids sent and the body's
  mention marks, members of the workspace only, never its author, at most 50. `quote` is folded to one
  line of up to 500 characters; a reply's `quote` and `inline` are ignored.
- Reading needs what reading the page needs; writing is for agents and up (viewers `403`) and people
  only: an API key reads comments but is `403` on every write except resolving. A page out of the
  caller's sight is `404`, and so are its comments and threads. A page in the trash keeps its comments
  to read; writing there is `422 page_in_trash`.
- Every change publishes `wiki_comment.changed` `{page_id, thread_id}` to the page's readers (scoped
  like the page's own events); the app refetches the page's comments.

## Following

Followers hear about every new comment on a page (`wiki_comment`). The page's creator follows it, and
so does everyone who comments on it. `PUT /v1/wiki/pages/{id}/follow` `{following}` → `{following}`
(people only, viewers included) follows or unfollows it; an unfollow is kept, so commenting again does
not follow the page back. Whoever wrote in a thread hears about its replies even after unfollowing the
page, and mentions reach people either way.

## Reminders

A date in a page's text with `data-reminder="<uuid>"` reminds someone (`wiki_reminder`). On every save
of a body (create, update, a daily note, a restored revision, a copy) the API makes the page's
reminders match it: an id new to the page belongs to the person saving; an id already there keeps its
owner; the time is the `datetime` read in the owner's notification timezone (`notifyprefs`, the email
schedule's), a bare date at 09:00 there; a changed time reminds again; an id gone from the body is
removed. A copy (Duplicate, a template, Save as template) gets new reminder ids, owned by whoever made
it; a template reminds nobody. At most 100 reminders per page. A job every minute (`wiki.reminders`,
`FOR UPDATE SKIP LOCKED` batches) sends each due reminder once, to its owner while they may see the
page; one more than a day late (a date already past when written) is dropped unsent. The notification's
`label` is the text of the block the date is in.

## Mentions and notifications

Notifications of the wiki are the `wiki` group (contracts/api.md "Notifications"); `ticket` is null:

| type | when | `data` |
| --- | --- | --- |
| `wiki_mention` | someone mentions you in a page's body (only people the save newly mentions: the body before and after are compared, a new page or a copy against nothing) or in a comment (new, or edited to mention you) | `{page_id, page_title, by, preview, thread_id?, comment_id?}` |
| `wiki_comment` | a new comment or reply on a page you follow, or in a thread you wrote in; never its author, nor someone it mentions (they get `wiki_mention`) | `{page_id, page_title, by, preview, thread_id, comment_id}` |
| `wiki_reminder` | a reminder you set is due | `{page_id, page_title, reminder_id, remind_at, label}` |

Only people who may see the page hear about it: a private page's member, a private team's members,
nobody about a page in the trash or a template's text. When a page leaves someone's sight (moved to
private pages or into a private team they are not on, trashed, deleted) their wiki notifications about
it and the pages under it are removed (`notification.deleted`), as tickets do. The app opens them at
`/wiki/<page id>`, with `?comment=<thread id>` for a comment's thread.

## Links and tags

As a page's body is saved (create, update, restore), the API keeps what it links to and its tags
(`wiki_links`, `wiki_pages.tags`; migration `000721` read them from pages written before):

- A link is a link to a page (`/wiki/<id>`, the page-link, subpage and synced blocks) of the same workspace;
  a link to a page that doesn't exist there is left out. Deleting a page removes its links both ways.
- A ticket mention (`<a data-type="ticket" data-id>`) is kept as the page's link to that ticket
  (`wiki_ticket_links`), for the ticket's list of pages ("Desk"). Contact mentions are kept in the text only.
- A tag is `#` and letters, digits, `_`, `/` or `-` with at least one letter (`#42` is a number), after
  a space or at a line's start, never inside code. Lower case, each once, at most 50 of 64 characters.
  `/` nests them (`#process/refunds` is under `#process`).

| method | path | | |
| --- | --- | --- | --- |
| GET | `/v1/wiki/pages/{id}/backlinks` | `wiki:read` | `Page<WikiMention>`: the pages linking to it, last edited first (at most 200) |
| GET | `/v1/wiki/pages/{id}/mentions` | `wiki:read` | `Page<WikiMention>`: unlinked mentions, the pages whose text has its title or one of its aliases as a phrase and no link to it (at most 100; none for an untitled page without aliases) |
| GET | `/v1/wiki/graph` | `wiki:read` | `Page<{from, to}>`: every link in the workspace (the pages are the tree's) |

```ts
interface WikiMention { id: string; parent_id: string | null; title: string; icon: string; snippet: string; updated_at: string }
```

The app shows them as Obsidian does: a page panel beside the page (Mod+Shift+;) with its outline, its
linked mentions, its unlinked mentions (each with Link, which links the first place that page names
this one, outside links and code, and saves it with that page's version), the pages it links to, its
local graph and what it holds (words, reading time, tags, who made and edited it); "N backlinks" under
the title; a graph of the whole wiki (`/wiki/graph`, `?focus=` a page, `?tag=`); the tags with their
pages (`/wiki/tags`, `?tag=`); a preview of a page while the pointer rests on a link to it; `#tags`
drawn as tags in the text; and a random page from the wiki's home.

## Search

`GET /v1/wiki/search?q=` matches titles and aliases (weighted highest) and bodies, every word also as a
prefix ("refu" finds "refunds"), like the knowledge base's `prefixQuery`. `GET /v1/search` (the
command palette) returns the top 5 pages in `wiki_pages` to callers that may read the wiki.

## Icons

`icon` is one emoji as Unicode spells them (UTS #51): an `Extended_Pictographic` character with an
optional variation selector and skin tone, several joined by ZWJ (families, professions), a flag
(a pair of regional indicators, or a black flag with tag characters), or a keycap. Anything else
(letters, bidi controls, zero-width characters other than the joiner, combining marks, two emoji)
is `422`. Every emoji the app's picker offers passes (`TestPickerEmoji`).

## Events

`wiki_page.created`, `wiki_page.updated`, `wiki_page.moved`: `{ wiki_page: WikiNode, updated_by }`;
`wiki_page.updated` also carries `settings: PageSettings` when the page's look changed (it has no
version to compare, so a client takes it as it comes).
`wiki_page.updated` carries `aliases` when they changed (see "Aliases").
`wiki_page.updated` carries `canvas` when a canvas's cards changed, or `canvas_changed: true` when the
canvas is too large to carry (over 256 KB; read the page) (see "Canvas").
`wiki_page.deleted`: `{ wiki_page_id, wiki_page_ids }` (the page and every subpage removed with it).
`wiki_comment.changed`: `{ page_id, thread_id }`: a thread of the page changed (a comment added,
edited or deleted, a reaction, resolved or reopened); refetch the page's comments.
Bodies are left out, as they are large and saved often: a client showing the page refetches it.
The web app patches the tree in place on `created`, `updated` and `deleted`, and refetches it on
`moved`. Audit: `wiki_page.created` `{title, parent_id}`, `wiki_page.deleted` `{title, subpages}`,
`wiki_page.imported` `{pages, files, skipped, parent_id}` (on the import's first top page),
`wiki.exported` `{pages, format}` (a zip; on the page exported, none for the whole wiki).

## Limits

| | |
| --- | --- |
| pages per workspace | 5,000, the trash and templates included (`422 wiki_full`) |
| depth | 10 levels (`422 page_too_deep`, counting the subpages a move takes along) |
| body | 512 KB (`422 page_too_large`) |
| title | 200 characters (`422`; the app's title field stops at 200) |
| aliases | 10 per page, 100 characters each (`422`) |
| revisions per page | 100 |
| comment | 20,000 characters of HTML, 50 mentions, 20 different reactions; an inline thread's quote 500 characters |
| reminders per page | 100 (more are not kept) |
| import | 100 MB uploaded, 200 MB unpacked, 10,000 files, 5,000 pages, 25 MB a file, 4 MB a page source; 20 imports an hour per workspace |
| export | 200 MB of page text (`422 export_too_large`), 1 GB of files in a zip (files past it link to the app); 30 zips an hour per person or key |

## Import and export

Pages come in from other tools and go out as files (`internal/helpdesk/wikiport` reads and writes
them; `internal/helpdesk/wiki/port.go` creates and reads the pages). Neither needs a plan.

### Import

`POST /v1/wiki/import` (agent; `wiki:write`, a person or an API key) takes a multipart form:

| field | |
| --- | --- |
| `files` | one zip, or several page sources with the files they use; repeat the field for each file. Up to 100 MB in all |
| `parent_id` | optional: a page of the tree the caller may see (not a database, not in the trash); the import's top pages go last under it, and live where it does |
| `space`, `team_id` | without `parent_id`: `workspace` (default), `private` (a person only) or `team` with `team_id`, as `POST /v1/wiki/pages` |

→ `201 {pages: number, root_ids: string[], skipped: {path, reason}[]}`: how many pages it made, the
pages at the top of the import in order, and what it left out or changed by its path in the upload.

What it reads:

| source | becomes |
| --- | --- |
| Obsidian vault (a zip with `.obsidian/`, or any Markdown) | a page per note, a page per folder (a folder note `X/X.md` or `X.md` beside `X/` is the folder's page), `[[links]]`, `[[note#heading]]`, `![[embeds]]` of notes and files, callouts, highlights, math, task lists, front matter (`title`, `tags`, `aliases`), `#tags`; comments `%%…%%` are dropped |
| Notion export (Markdown & CSV, or HTML) | the page tree (Notion's ids leave titles), links between pages and to `notion.so` pages of the export, callouts, toggles, page icons; a database's CSV (the `_all` one when there are two) becomes a database: the first column its title, each other column's type read from its values (checkbox, number, date and date ranges, URL, email, select, multi-select, status; people and relations as text), each record a row with its values, matched by title to the row's own page so it keeps its text and subpages |
| Confluence, Google Docs or other HTML | a page per HTML file, its title from `<title>` or its first heading, Confluence's info, note and warning panels as callouts |
| Obsidian canvas (`.canvas`, JSON Canvas 1.0; in a vault or alone) | a canvas page ("Canvas"): text nodes' Markdown read as a note's (`[[links]]`, embeds, tags), `file` nodes naming a note or canvas of the upload page cards, other files of the upload file cards (stored as the page's files), https `link` nodes link cards, groups with their labels, connections between the cards kept; colours `"1"`..`"6"` and `#rrggbb` (`#rgb` written out) kept; ids the wiki takes kept, others replaced; positions and sizes brought within a canvas's bounds. Notes link to a canvas as `[[Name.canvas]]` |
| Markdown, text, CSV files | a page each; a CSV a database |

Bodies are wiki HTML (`hd.SanitizeWiki`), as any other. Files the pages use become imported
attachments of the importer (`attachments.imported`, counted against the plan's import limit,
contracts/billing.md "Imports") and the pages' own ("Files"); files no page uses are not stored.
All the pages are made in one transaction, under the tree's lock: ids first (bodies link forward and
back), then each page in order with its position, a database with its schema checked as
`POST /v1/wiki/pages` checks one, each row with its values checked as a row's are (a value the
database refuses is left out). Each page gets its first revision, its links, tags and ticket
mentions indexed, its files, and its importer as a follower; mentions in it notify nobody. Files are
stored before the transaction; an import that fails removes them again. One `wiki_page.created` per
page follows, parents first, to those who may see it, and one audit entry.

It is refused whole, before anything is stored: `422 wiki_full` when its pages don't fit in the
workspace's 5,000 (the message says how many it makes and how many fit); `422 page_too_deep` under a
page at the 10th level; `422 import_into_database` under a database; and wikiport's own:
`413 import_too_large`, `422 import_unsupported`, `import_unreadable`, `import_too_many_files`,
`import_unsafe_path` (links, absolute paths, `..`), `import_compression` (an entry expanding over
100 times past 1 MB), `import_empty`. A tree deeper than fits below where it lands is lifted:
pages past the last level go beside their ancestor there.

`skipped[].reason`:

| reason | |
| --- | --- |
| `unsupported` | a kind of file that isn't imported (Obsidian bases) |
| `unused` | a file no page uses |
| `executable` | a program or a script, by its name or its bytes; never imported |
| `too_large` | a file over 25 MB, or a page source over 4 MB |
| `unreadable` | a file whose text or table could not be read, a canvas that isn't a JSON Canvas object (no page is made), or a table the wiki can't keep as a database (its rows stay pages) |
| `body_too_large` | a page whose text is over 512 KB, or a canvas over 1 MB; the page is made without it |
| `moved_up` | a page deeper than the wiki holds, placed beside its ancestor at the last level |
| `columns_dropped` | a table's columns past a database's 100 properties |
| `nested_archive` | an archive inside the upload |
| `files_limit` | a file past the plan's import limit; what used it is left out of the page |
| `canvas_simplified` | a canvas with cards kept simpler, listed once per canvas: a card for a note's heading or block (`subpath`) shows the whole note; an http link, a file or note not in the upload, or a file not taken (a program, too large) is a text card; a group's background picture and nodes of types JSON Canvas doesn't define are left out |
| `canvas_trimmed` | a canvas's nodes past 2,000 or connections past 4,000, left out |

### Export

| method | path | | |
| --- | --- | --- | --- |
| GET | `/v1/wiki/pages/{id}/export?format=markdown\|html&subpages=false\|true` | viewer; `wiki:read` | a page the caller may see, not in the trash (`404` otherwise). Without subpages (or with none they may see): one file, `<title>.md` (`text/markdown; charset=utf-8`), a canvas's `<title>.canvas` (`application/json; charset=utf-8`) or `<title>.html` (`text/html; charset=utf-8`), its links to pages and files pointing to the app. With `subpages=true`: `<title>.zip`, the page and every subpage the caller may see, not in the trash |
| GET | `/v1/wiki/export?format=markdown\|html` | viewer; `wiki:read` | `Wiki <YYYY-MM-DD>.zip`: every page of the caller's tree: the workspace's, the teamspaces they may see, their own private pages; not the trash, not templates. Any member exports what they may read. `422 wiki_empty` without pages |

`format` defaults to `markdown`: an Obsidian vault, a `.md` per page with YAML front matter (title,
icon, aliases, dates, tags, a row's values), its subpages in a folder of the same name beside it, `[[links]]`
between pages, a database as a table of its rows and a `.csv` beside it, a canvas as a JSON Canvas
`<title>.canvas` ("Canvas"). `html` is a standalone page per file, linked by relative paths; a canvas's
page draws its cards and connections. A zip carries the files its pages use under `attachments/` when
the caller may read them as `GET /v1/attachments/{id}` would let them (a page's file, their own
upload not sent yet), up to 1 GB; a link to any other file or to a page it doesn't carry goes to the
app. Signed links never leave in an export. Every download is `Content-Disposition: attachment`,
`nosniff`, a sandbox CSP and `no-store`; a zip is streamed and audited (`wiki.exported`).

## Desk

The wiki sits beside the desk: pages mention tickets and contacts, show a saved view's tickets, and
become help center articles; a ticket lists the pages that mention it. Each reader sees what their own
access shows them (contracts/teams.md "Visibility"): a mention grants nothing.

### Mentions

`<a data-type="ticket" data-id="<ticket id>" href="/tickets/<number>">#<number> <subject></a>` and
`<a data-type="contact" data-id="<contact id>" href="/contacts/<contact id>">name</a>`. `hd.SanitizeWiki`
keeps exactly that on them: `data-type`, a uuid `data-id` and the app's own route of that kind as `href`
(a ticket's number, a contact's id); another `href` or any other attribute is dropped, and a link
without an id is a plain link. The text is what the writer saw when they mentioned it. The app draws
a ticket live for a reader who may see it (status, `#number`, subject; a card with status, assignee
and last update on hover; a click opens it) and as "a ticket you can't see" for anyone else, without
its subject; a contact with its initial and name, opening the contact. The editor offers tickets from
"@" and "#" (a number, or text to search) and contacts from "@", through the app's search. An article
made from the page ("Publishing") and its Markdown keep only the text.

### Ticket list

`<div data-type="tickets" data-id="<saved view id>" data-limit="<number>">`, inserted with "/tickets":
the view's open tickets, live, as compact rows (number, subject, status, assignee, last update) with a
link to the whole view. The app offers 5, 10 or 25 rows. The rows are read through `GET /v1/tickets`
with the view, as the reader: they see the tickets they may see, or the block's empty line.

### Ticket backlinks

As a page's body is saved (create, update, restore, a copy of a template), the API keeps the tickets
it mentions in `wiki_ticket_links` beside its links ("Links and tags"; migration `000725` read them
from pages written before). Only tickets of the page's workspace count; an id that names none is left
out. The link goes with the page or the ticket when either is removed for good.

| method | path | | |
| --- | --- | --- | --- |
| GET | `/v1/tickets/{id}/wiki` | viewer; `tickets:read` and `wiki:read` | `Page<WikiNode>`: the pages of the caller's tree (not the trash, not templates, not someone else's private page, not a page of a private team they are not on) that mention the ticket, last edited first, at most 50. `{id}` is the ticket's id, alias, `#123` or `123`; a ticket the caller may not see is `404`, as on every ticket route, and the route answers `403 feature_disabled` while Tickets is off |

The ticket's details show them as "Wiki", each opening the page, and nothing when there are none. The
app refetches them on `wiki_page.created`, `wiki_page.updated` and `wiki_page.deleted`.

### Publishing

`POST /v1/kb/articles/from-wiki` (contracts/api.md) copies a page the caller may see into a new draft
article of the help center (agent; `kb:write` and `wiki:read`; `internal/helpdesk/kb/from_wiki.go`,
`internal/helpdesk/wikiconv`). Blocks become their article equivalents; mentions of teammates,
tickets and contacts and links to pages keep only their text; the workspace's own files and images,
databases and subpage links stay in the wiki and are counted in `left_out`. Nothing stays linked: later
edits of the page never reach the article. The app offers it from the page menu ("Publish to help
center") to members who may write articles, except on templates, the journal and databases: a title, a
collection and, with several brands, a brand; then a link to the draft.

### Ollie writing

`POST /v1/wiki/ai/write` (contracts/ai.md; agent) has Ollie edit a selection (improve, fix grammar,
shorter, longer, simplify, more formal, friendlier, summarize, action items, explain) or write at the
cursor from the page around it (continue, or a free ask). The answer is wiki HTML, sanitized like a
body, and a proposal: the member replaces the selection with it, inserts it below, tries again or
drops it. Nothing is saved until they do. The app offers it as "Ask Ollie" over selected text and
"/ai" (or Space) on an empty line, to agents of a workspace with AI on.

## AI

- **Ollie writing** (`POST /v1/wiki/ai/write`): edits a selection or writes from the page at the
  member's request; a proposal they insert or drop, never saved by itself ("Desk").
- **Ollie** (`internal/ai/assistant`) has `search_wiki` and `get_wiki_page` read tools and links
  the pages it used (`Ref.kind: "wiki_page"`). The page context carries `wiki_page_id` on a wiki
  page. Writing goes through `api_change` and its approval, like other settings.
- **MCP** (`contracts/agent.md` "opendesk MCP server"): `search_wiki`, `get_wiki_page`
  (`wiki:read`), `create_wiki_page`, `update_wiki_page` (`wiki:write`; markdown bodies).
- Never the widget agent, the email agent, suggested replies or anything a customer sees.
- An admin writing an agent procedure may copy a page's text into its instructions once
  (`contracts/agent.md` "Procedures"). The copy is the procedure's own text from then on: nothing stays
  linked, and later edits of the page never reach the agent.

# Contributing to opendesk

Thanks for helping. opendesk is open source under the [Apache-2.0 license](LICENSE), and issues,
discussion and pull requests are all welcome. By taking part you agree to the
[Code of Conduct](CODE_OF_CONDUCT.md).

The full guide, with the repository map and how to run every part, is at
[docs.opendesk.sh/contributing](https://docs.opendesk.sh/contributing/). This page is the short version.

## Before you start

- **Search first.** Someone may already have reported it or be working on it. A pull request that
  lands on top of another one costs both of you time.
- **Open an issue for anything larger than a fix.** A new feature, a design change or a new
  dependency is easier to agree on in words than in a diff. For a small fix, send the pull request.
- **Security issues are private.** Use [a security advisory](https://github.com/useopendesk/opendesk/security/advisories/new)
  or email `team@opendesk.sh`. See [SECURITY.md](SECURITY.md).
- **Read the rules of the part you change.** [`AGENTS.md`](AGENTS.md) describes how the repository
  fits together, and [`contracts/`](contracts/) holds the contracts between parts: API, events,
  realtime and tokens. Read the relevant contract before you change an interface.

## Set up

You need Go, Node.js with pnpm, Elixir and Docker for Postgres.

```sh
cp .env.example .env
make dev-db      # Postgres on localhost:55432
make api         # the Go API and workers
make realtime    # the Elixir gateway
make web         # the web app on :5173
```

## Make the change

- One logical change per pull request, on a branch of your fork.
- Follow the conventions in [`AGENTS.md`](AGENTS.md). The ones people trip on most:
  - Go: `gofmt`, then `go build ./... && go vet ./...`. Create tickets and messages only through
    `domain.CreateTicket` and `domain.AddMessage`.
  - Migrations are numbered above the highest on `main`, each with an `.up.sql` and a `.down.sql`.
  - Clients get stable error codes, never raw error text.
  - Web: the design tokens in `brand/tokens.css`, light and dark themes, keyboard first, realtime
    over polling, and strings in every locale.
  - Copy is in sentence case, in plain words, with no em dashes.
  - Describe a security invariant in comments, commits and docs, never a gap.
- Add tests where they make sense, and update the docs and `contracts/` when behavior or an
  interface changes.

## Check it

Run CI's checks for what your branch changes, on your machine, against the committed HEAD:

```sh
git commit ...
cd qa && pnpm install    # once
pnpm qa
```

Fix what fails, commit and run it again. See [`qa/README.md`](qa/README.md).

## Commits and pull requests

- A commit message is one line: `feat: let an admin merge two contacts that are one person`.
  Use `feat:` for something new, `fix:` for something broken, and `docs:`, `build:` or `chore:`
  where they fit. No body and no trailers.
- The pull request template asks for the problem, what changes, notes and QA. Open with the
  problem in plain prose, name the tests you ran and their exact results, and say plainly what you
  did not run. Link the issue with `Fixes #123`.
- Frontend changes include screenshots, light and dark.
- A maintainer reviews every pull request, and CI must pass before it joins the merge queue.
  Keep your branch mergeable with `main`: if a conflict appears, merge `main` into it and push.
  Never force-push over a review in progress.

## Help in other ways

Triage and reproduce open bugs, improve the docs, translate the app, or answer questions in
[Discord](https://dc.opendesk.sh). Issues labelled
[good first issue](https://github.com/useopendesk/opendesk/labels/good%20first%20issue) and
[help wanted](https://github.com/useopendesk/opendesk/labels/help%20wanted) are good places to start.

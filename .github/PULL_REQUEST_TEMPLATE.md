<!--
Open with the problem: what a user, customer or operator hits today, in plain prose.
Delete any section that does not apply. One logical change per pull request.
-->

## Problem

## What changes

-

## Notes

<!-- Decisions, boundaries, what you left out on purpose, and anything a reviewer should know. -->

## Screenshots

<!-- Frontend changes: before and after, light and dark. Delete for anything else. -->

## QA

<!--
Name the tests you added or ran and their exact results. Say plainly what you did not run.
For example: `pnpm qa` passes; `TestContactBulk` covers the 100 id limit.
-->

## Checklist

- [ ] `pnpm qa` (in `qa/`) passes on the committed HEAD
- [ ] The commit message is one line, such as `feat: let an admin merge two contacts`
- [ ] Tests cover the change, or the QA section says why not
- [ ] Docs and `contracts/` are updated when behavior or an interface changed
- [ ] A migration is numbered above the highest on `main`, with its `.down.sql`
- [ ] No secrets, tokens or personal data in the diff, logs or screenshots
- [ ] The [security invariants](https://docs.opendesk.sh/security/) still hold

Fixes #

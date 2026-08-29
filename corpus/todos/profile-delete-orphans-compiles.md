---
title: DELETE /profiles/:id never cancels the compiles on the profile it deletes
created: 2026-08-29
status: promoted
tags: [backend, latex, profiles, cleanup, bug]
---


> Promoted 2026-08-29 → [brief 45](../briefs/todo/45-profile-delete-cancels-compiles.md).
# `DELETE /profiles/:id` never cancels the compiles on the profile it deletes

Found during **brief 44**'s review and deliberately left — it is a pre-existing
gap, not something that build introduced.

[`apps/api/src/profile-routes.ts:206-256`](../../apps/api/src/profile-routes.ts)
deletes a profile without cancelling any compile running on it, and leaves the
projects' trees on disk. `latex_projects.profile_id` is `ON DELETE CASCADE`
([`db.ts:427`](../../apps/api/src/db.ts)), so the row vanishes **while the job
still holds the account's single-flight slot**.

**This is the root cause of one of brief 44's Important findings.** That brief
fixed only the *mis-reporting* — the 409 no longer hands back a
`runningProjectId` that addresses a deleted project — so the slot is still
uncancellable until the compile ends on its own, bounded by `LATEX_TIMEOUT_MS`.

**The fix is small and the shape already exists.** `DELETE /latex/:id` does it:
iterate `listLatexProjects` and `await cancelAndSettleLatexCompile(p.id)` before
deleting. Worth doing the orphaned-tree cleanup in the same pass.

See [briefs/done/44-compile-worker-thread.md](../briefs/done/44-compile-worker-thread.md)
and [wiki/latex.md](../wiki/latex.md).

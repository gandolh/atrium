---
title: A swallowed setLatexCompileStatus failure can wedge an account until restart
created: 2026-08-29
status: open
tags: [backend, latex, durability, bug]
---

# A swallowed `setLatexCompileStatus` failure can wedge an account until restart

Found during **brief 44**'s review and deliberately left: the code is
**byte-identical to the pre-brief-44 version**, so it is not that work's defect.

In [`apps/api/src/latex-compile.ts`](../../apps/api/src/latex-compile.ts),
`runCompile`'s `finally` swallows a failing `setLatexCompileStatus`.

**The swallow is correct for one case and wrong for another.** A zero-row
`UPDATE` — the project was deleted mid-compile — is exactly what should be
ignored. But `SQLITE_BUSY` / `SQLITE_FULL` are swallowed identically, and then
the row stays `running` while the in-process job map is already empty. Nothing
reconciles the two: `reapInterruptedLatexCompiles` runs **at import**, so the
account stays wedged until the API restarts.

**The fix is to distinguish them** — treat "no rows matched" as benign and
anything else as an error worth retrying or at least logging, rather than
inferring benignness from the fact that a write failed.

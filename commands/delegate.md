---
description: Split a piece of work into tasks and hand them to your other AI accounts through omnitrix
argument-hint: "<the work to hand off>"
---

Hand this work to other AI accounts through omnitrix, and stay the lead who plans and checks it: $ARGUMENTS

1. Call `pool_status` to see which accounts are ready and how much quota they have left.
2. Split the work into small, independent tasks. Give each a clear title, a type (`code`, `code_snippet`, `review`, `reasoning`, `long_context`, `bulk`, `writing` or `vision`), a precise prompt and an `acceptance` line that says what done means. Tasks that edit files need type `code`, the `repo` path, the `files` they may change and, where the project has tests, a `test` command; give parallel code tasks separate files. Set `privacy` to `private` for the user's own code and `secret` for confidential material.
3. Keep the planning, the tricky decisions and anything that needs this conversation's context for yourself. Delegate the bulk work: reading, drafting, boilerplate, tests and first drafts.
4. Call `dispatch` with all independent tasks at once, then `get_results`.
5. Check every result against its acceptance line. For code jobs, read `verify`: the changed files, files the task did not name, the test result, `also_changed` and `lockfiles`. Call `rate_result` for each job; to retry rejected work on another model, pass `accepted` false, a note and `retry` true.
6. Merge accepted code branches yourself (`git merge omnitrix/<job id>`), combine files that several jobs changed, regenerate a lockfile that several jobs changed and check it with `omnitrix lockcheck`, then run the project's tests and report what was done.

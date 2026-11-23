---
description: Have several different models review code independently, then keep only the findings that hold up
argument-hint: "[files, folder or git range; defaults to the uncommitted changes]"
---

Review the following with omnitrix, using several independent reviewers: $ARGUMENTS

1. Decide what to review. If the line above names files, a folder or a git range, use that. If it is empty, use the uncommitted changes (`git diff HEAD`); if there are none, use the last commit (`git show HEAD`). Read the material yourself first, so that you can judge the findings later.
2. Call the omnitrix `dispatch` tool with one task:
   - type `review`, a short title, and `copies` 3, so that three different models answer independently;
   - the prompt: the code or diff to review, with file names and line numbers, and the question "List real bugs, security problems and missed edge cases. For each, give the file, the line and a one-sentence reason. Do not list style preferences.";
   - `acceptance`: "Each finding names a file, a line and a concrete failure.";
   - `privacy` `private`, or `secret` if the code is confidential (then only local models are used). Use `public` only for code that is already public.
3. Call `get_results` for the three jobs. Group the findings: a finding that two or three reviewers report independently is more likely real; one that a single reviewer reports needs a closer look.
4. Check every finding against the code yourself before reporting it. Drop the ones that are wrong, and say how many you dropped.
5. Call `rate_result` for each job: accepted true if most of its findings held up, false otherwise, with a short note.
6. Report the confirmed findings, most serious first, and say which reviewers found each one.

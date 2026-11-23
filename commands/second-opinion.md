---
description: Ask a different model to check an answer, plan or decision before you rely on it
argument-hint: "[the question, plan or answer to check; defaults to your last answer]"
---

Get a second opinion from another model through omnitrix on: $ARGUMENTS

1. If the line above is empty, use your own last answer or plan in this conversation. Write down the question and the answer to check in a few lines, with only the context a newcomer needs.
2. Call the omnitrix `dispatch` tool with one task of type `reasoning`, a short title, and the prompt "Here is a question and a proposed answer. Find what is wrong, missing or risky in the answer, and say what you would do instead. If it is correct, say so and explain why." followed by the question and the answer. Set `acceptance` to "Names concrete problems with reasons, or explains why the answer holds." Use `privacy` `private`, or `secret` for confidential material.
3. Call `get_results` and read the reply. Treat it as advice: check each point yourself.
4. Call `rate_result` with accepted true if the reply was useful and correct, false otherwise.
5. Tell the user where the other model agreed, where it disagreed, and what you now recommend, changing your earlier answer where it was right to.

---
description: Show the omnitrix pool: which accounts are ready, their quota left and when it resets
---

Call the omnitrix `pool_status` tool and show the result to the user.

If you can draw visual widgets, show one card per account with its state, a meter for each quota window, its reset time and any paused models. Otherwise show a short table with the same facts. Under it, add one line for each account that is not ready, saying why and what the user can do, such as starting Ollama or waiting for a reset.

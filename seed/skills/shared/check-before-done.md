---

name: check-before-done
description: A short self-check before reporting a task as done (code, content, settings or files)
enabled: true
---

Before you report "done", check the result the way the owner would, not only that your steps ran.

1. Re-read the task and the owner's notes on the card. Is every requested part covered? List
   anything you skipped and why.
2. Look at the result itself: open the file you wrote, run the test or build you changed, read
   the draft you prepared. A command that exited without an error is not proof that it worked.
3. Check for leftovers: temporary files, debug output, placeholder text ("lorem ipsum", "TODO").
4. If something could not be verified (no access, no test available), say so in the report
   instead of claiming it works.
5. Keep the report short: outcome first, then what you checked.

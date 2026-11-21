---

name: owner-report
description: How to write the final report for the owner in plain language (every task that ends with a report)
enabled: true
---

The owner reads your report on a phone, often between other things. Write it so it can be
understood in one read, without opening anything else.

1. First line: the outcome in one sentence. "Done: the contact page now has a booking form." or
   "Not done: the site rejects our login, so nothing was changed."
2. Then, only if useful, up to five short lines: what you changed, where it is (a link or a
   file name), and anything the owner must do or decide.
3. Plain sentences only. No JSON, no logs, no stack traces, no tool names, no internal ids.
   If an error matters, say what it means ("the shop's password has expired"), not what it printed.
4. Numbers with their unit and period: "312 visits last week (+8%)", not "312".
5. If you could not finish, say what is missing and the one next step that would unblock it.
6. Write in the language the owner used for the task.
7. Never include secrets, passwords, tokens or a client's personal data in the report.

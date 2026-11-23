# ADR-0065: Checks before review

Status: Accepted (2026-11-23). Amends ADR-0030.

- Context: Finished work goes to review automatically (ADR-0030), and a card sent back restarts its agent (ADR-0062). When the agent had not built or run what it wrote, the reviewer could only read the code and argue about cases neither had tried; each round found new ones and none settled anything. Agents say honestly in their report when they did not build or test, but nothing acted on it.

- Decision:
  - A workflow column's `on_enter` may say `needs_checks: true`. It is off in the seeded workflow.
  - The agent working a card in such a workflow gets a hub tool, `report_checks` (`passed`, `summary`), and one prompt line: build, run the tests, report; if that is impossible, report that and why.
  - When its run ends, the card enters the finish column only with a passing report for that task. Otherwise it stays where it is and the chat says so, with the agent's reason: no review run is spent, and the owner decides (reply to have it continue, or move the card). Each rework needs its own report.
  - The reviewer is given the agent's summary of the checks. Reviews themselves report none.
  - The report is the agent's word; the gateway does not run builds. A build tool that needs an app open (Unity) or minutes of exclusive use is the agent's to drive, not a step the gateway can run blind.

- Consequences: Review time goes to work that at least compiles and passes its tests, and the owner hears at once when an agent could not verify its work, which is usually a missing tool or permission worth fixing. An agent could report a pass it did not get; the reviewer and the owner still see the summary.

# ADR-0057: Project websites open to the agent working on the project

Status: Accepted (2026-11-23)

- Context: A website is readable by an agent only when its own `network.allow` lists the host. The owner gives a task to the boss and the boss picks the agent, so the owner cannot know in advance which agent needs a client's site, and granting every agent every client site would widen all of them. A project already lists its client's sites under `integrations.website` (project.yaml).

- Decision: A run of a task that belongs to a project gets `WebFetch` scoped to the hosts of that project's `website` list (exact hosts, from the URLs; entries that are not URLs are skipped), whichever agent runs it, added to the agent's own list. It applies to that run only; agent.yaml is not changed. Workers and discussion turns keep their own narrower tools. Codex and Gemini runs open their network only for the open web (`*`), so for them the project hosts change nothing.

- Consequences: Adding a site to a project is enough for any agent on its tasks to read it. Every such agent can be fed that site's content, which is data, not instructions, as for any fetched page. Other projects' sites stay closed.

# ADR-0023: Manifest parsing with `yaml` and `zod`

Status: Accepted (2026-11-19)

- Context: `agent.yaml` (ADR-0010) needs a YAML parser, which Node does not ship, and strict schema validation with clear errors. The official MCP TypeScript SDK (`@modelcontextprotocol/sdk`, needed for the MCP layer) already depends on `zod` (`^3.25 || ^4.0`).
- Decision: Use `yaml` (ISC, no dependencies) for parsing and `zod` v4 (MIT, no dependencies) for validation. Schemas are `.strict()`: unknown keys are errors, so a typo cannot silently drop or widen a rule.
- Consequences: Two runtime dependencies in `packages/policy`; `zod` would arrive with the MCP SDK anyway. Manifest TypeScript types are derived from the schema.

// Policy engine: agent manifests and deny-by-default checks (ADR-0010).
export const PACKAGE_NAME = "@achords/policy";

export { agentSummary } from "./agent-doc.ts";
export * from "./check.ts";
export {
  createAgentFiles,
  type NewAgent,
  updateManifestModels,
  updateManifestName,
} from "./edit.ts";
export {
  loadAgents,
  loadManifest,
  type Manifest,
  manifestSchema,
  parseManifest,
} from "./manifest.ts";
export {
  checkMove,
  DEFAULT_WORKFLOW_YAML,
  loadWorkflow,
  type MoveCheck,
  type Mover,
  parseWorkflow,
  permissionMatrix,
  type Workflow,
  workflowSchema,
} from "./workflow.ts";

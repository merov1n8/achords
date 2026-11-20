// Policy engine: agent manifests and deny-by-default checks (ADR-0010).
export const PACKAGE_NAME = "@achords/policy";

export { agentSummary } from "./agent-doc.ts";
export {
  allowedIntegrationTools,
  type Catalog,
  type CatalogEntry,
  catalogEntrySchema,
  grantedIntegrations,
  loadCatalog,
  secretRefs,
} from "./catalog.ts";
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
export { allowRules } from "./permissions.ts";
export { createProject, loadProjects, type Project, updateProject } from "./projects.ts";
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

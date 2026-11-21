// Policy engine: agent manifests and deny-by-default checks (ADR-0010).
export const PACKAGE_NAME = "@achords/policy";

export { agentSummary } from "./agent-doc.ts";
export {
  accountRef,
  accountRefs,
  allowedIntegrationTools,
  type CallScope,
  type Catalog,
  type CatalogEntry,
  catalogEntrySchema,
  grantedIntegrations,
  type IntegrationStatus,
  integrationStatus,
  loadCatalog,
  type PublishMode,
  publishMode,
  type SiteStatus,
  scopeRefusal,
  scopeTargets,
  secretRefs,
  siteCredentials,
  siteSlug,
  siteStatus,
} from "./catalog.ts";
export * from "./check.ts";
export {
  AGENT_LIST_FIELDS,
  type AgentListField,
  type AgentPatch,
  createAgentFiles,
  manifestChanges,
  type NewAgent,
  patchManifestText,
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
export { costOf, loadPricing, type Pricing } from "./pricing.ts";
export {
  createProject,
  loadOwnAccounts,
  loadProjects,
  OWN,
  ownProject,
  type Project,
  saveOwnAccounts,
  updateProject,
} from "./projects.ts";
export {
  closestSkills,
  deleteSkill,
  findSkill,
  formatSkill,
  isSkillName,
  isSkillWorkspace,
  listSkills,
  parseSkillText,
  readSkill,
  SHARED_SKILLS,
  type Skill,
  skillHash,
  skillPath,
  visibleSkills,
  writeSkill,
} from "./skills.ts";
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

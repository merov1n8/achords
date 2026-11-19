// Policy engine: agent manifests and deny-by-default checks (ADR-0010).
export const PACKAGE_NAME = "@achords/policy";

export * from "./check.ts";
export { updateManifestModels } from "./edit.ts";
export {
  loadAgents,
  loadManifest,
  type Manifest,
  manifestSchema,
  parseManifest,
} from "./manifest.ts";

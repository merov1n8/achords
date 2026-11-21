// Platform layer: hardware detection and local model recommendations (ADR-0015).
export const PACKAGE_NAME = "@achords/platform";

export {
  findContainerBin,
  IMAGE_REPO,
  imageTag,
  inSubnet,
  parseNetwork,
  runContainerNames,
  runContainerPrefix,
  staleImages,
} from "./container.ts";
export { detectPlatform, type PlatformInfo, recommendModels } from "./platform.ts";

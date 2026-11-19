import { arch, platform, totalmem } from "node:os";

export interface PlatformInfo {
  kind: "apple-silicon" | "generic";
  ramGb: number;
}

export function detectPlatform(
  sys: { platform: string; arch: string; totalmem: number } = {
    platform: platform(),
    arch: arch(),
    totalmem: totalmem(),
  },
): PlatformInfo {
  return {
    kind: sys.platform === "darwin" && sys.arch === "arm64" ? "apple-silicon" : "generic",
    ramGb: Math.round(sys.totalmem / 2 ** 30),
  };
}

// Roughly a third of RAM for model weights (q4), leaving room for macOS, browsers and agents.
// Tags verified against the Ollama registry on 2026-11-19; owners can override per agent.
const CHAT_BY_RAM: [minGb: number, model: string][] = [
  [64, "qwen3:32b"],
  [32, "qwen3:14b"],
  [24, "qwen3:8b"],
  [16, "qwen3:4b"],
  [0, "qwen3:1.7b"],
];

export function recommendModels(ramGb: number): { chat: string; embedding: string } {
  const chat = CHAT_BY_RAM.find(([min]) => ramGb >= min)?.[1] ?? "qwen3:1.7b";
  return { chat, embedding: "nomic-embed-text" };
}

// Gateway entrypoint (launchd ProgramArguments points here).
import { resolveHome } from "@achords/core";
import { runGateway } from "./gateway.ts";

process.exitCode = await runGateway(resolveHome());

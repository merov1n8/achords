import { describe, expect, it } from "vitest";
import { renderUnit, systemdService, UNIT } from "./systemd.ts";

const input = {
  nodePath: "/usr/bin/node",
  gatewayEntry: "/opt/achords 2/apps/gateway/src/main.ts",
  home: "/home/x/.achords 100%",
  path: "/home/x/.local/bin:/usr/bin",
};

describe("systemd unit", () => {
  it("restarts only after failures and quotes paths safely", () => {
    const unit = renderUnit(input);
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain(
      'ExecStart="/usr/bin/node" "--disable-warning=ExperimentalWarning" "/opt/achords 2/apps/gateway/src/main.ts"',
    );
    // % is a systemd specifier and must be doubled.
    expect(unit).toContain('Environment="ACHORDS_HOME=/home/x/.achords 100%%"');
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).toContain('Environment="PATH=/home/x/.local/bin:/usr/bin"');
  });

  it("enables and starts as a user service; stop only when active", () => {
    const calls: string[][] = [];
    let active = false;
    const svc = systemdService(input, {
      unitPath: "/tmp/u.service",
      writeFile: () => {},
      systemctl: (args) => {
        calls.push(args);
        if (args[0] === "is-active" && !active) throw new Error("inactive");
      },
    });
    svc.start();
    expect(calls).toContainEqual(["daemon-reload"]);
    expect(calls).toContainEqual(["enable", "--now", UNIT]);
    expect(svc.stop()).toBe(false);
    active = true;
    expect(svc.stop()).toBe(true);
    expect(calls).toContainEqual(["stop", UNIT]);
  });
});

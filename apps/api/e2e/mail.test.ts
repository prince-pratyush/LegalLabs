import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { startFakeSmtp } from "../src/test-smtp.js";
import { until, useStack } from "./session.js";

// The built server.ts with a mail server in this process: a guest gets a code and signs in.
const smtp = await startFakeSmtp();
afterAll(() => smtp.stop());
let logs = "";
const { call, post, workspace, serverEnv } = useStack({
  env: {
    LEGALLABS_SMTP_HOST: "127.0.0.1",
    LEGALLABS_SMTP_PORT: String(smtp.port),
    LEGALLABS_SMTP_SECURITY: "none",
    LEGALLABS_MAIL_FROM: "no-reply@firm.test",
  },
  log: (line) => {
    logs += line;
  },
});

const GUEST = "lead@other.test";

describe("guest sign-in through the running server", () => {
  it("emails the code, which signs the guest in and appears in no log", async () => {
    const { space } = await post<{ space: { id: string } }>(
      "/api/v1/spaces",
      { name: "Outside deal", kind: "external" },
      201,
    );
    await post(
      `/api/v1/spaces/${space.id}/parties`,
      { name: "Other LLP", domain: "other.test", connection_admin_emails: [GUEST] },
      201,
    );
    const { token } = await post<{ token: string }>(
      `/api/v1/spaces/${space.id}/guests`,
      { email: GUEST },
      201,
    );
    await post("/guest/invites/accept", { token, name: "Lee" });

    const asked = await call("/guest/login/code", {
      method: "POST",
      body: JSON.stringify({ workspace: workspace(), email: GUEST }),
    });
    expect(asked.status).toBe(204);
    const mail = await until(
      async () => smtp.received.find((m) => m.to.includes(GUEST)),
      (m) => m !== undefined,
      "the code to arrive",
      20_000,
    );
    const code = /is (\d{8})/.exec(mail?.data ?? "")?.[1] ?? "";
    expect(code).toMatch(/^\d{8}$/);
    await post("/guest/login/verify", { workspace: workspace(), email: GUEST, code });
    expect(logs).not.toContain(code);
  });

  it("will not start in production without a mail server once there are guests", async () => {
    const env: Record<string, string> = {
      ...serverEnv(),
      PORT: "0",
      NODE_ENV: "production",
      LEGALLABS_ALLOW_NO_MFA: "1",
    };
    for (const name of Object.keys(env)) {
      if (/^LEGALLABS_(SMTP|MAIL)_/.test(name)) delete env[name];
    }
    const server = fileURLToPath(new URL("../dist/server.js", import.meta.url));
    const child = spawn(process.execPath, [server], { env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    const exit = await new Promise((resolve) => child.once("exit", resolve));
    clearTimeout(timer);
    expect(exit).toBe(1);
    expect(stderr).toContain("mail is not configured");
  });
});

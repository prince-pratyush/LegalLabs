import { describe, expect, it } from "vitest";
import { mfaStartupCheck } from "./config.js";

/*
 * Pen-test P-09 (SEC-007, 06-security 3.2): the default policy is "required for admins", but a
 * deployment that never set the MFA variables ran with no second factor and no step-up, silently.
 */
describe("P-09 start-up check for MFA", () => {
  it("is quiet when MFA is configured", () => {
    expect(mfaStartupCheck({ NODE_ENV: "production" }, true).action).toBe("ok");
  });

  it("refuses to start in production without MFA, naming the variables and the opt-out", () => {
    const r = mfaStartupCheck({ NODE_ENV: "production" }, false);
    expect(r.action).toBe("refuse");
    expect(r.message).toContain("LEGALLABS_MFA_KEY");
    expect(r.message).toContain("LEGALLABS_ALLOW_NO_MFA=1");
  });

  it("lets an operator accept running without it in production, with a warning", () => {
    const r = mfaStartupCheck({ NODE_ENV: "production", LEGALLABS_ALLOW_NO_MFA: "1" }, false);
    expect(r.action).toBe("warn");
  });

  it("only warns outside production", () => {
    expect(mfaStartupCheck({}, false).action).toBe("warn");
    expect(mfaStartupCheck({ NODE_ENV: "development" }, false).action).toBe("warn");
  });

  it("does not take anything but 1 as the opt-out", () => {
    for (const v of ["", "0", "true", "yes"]) {
      expect(
        mfaStartupCheck({ NODE_ENV: "production", LEGALLABS_ALLOW_NO_MFA: v }, false).action,
      ).toBe("refuse");
    }
  });
});

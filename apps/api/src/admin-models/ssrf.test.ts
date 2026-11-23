import { describe, expect, it } from "vitest";
import { httpDiscovery, safeConnectorUrl } from "./discovery.js";

/*
 * Pen-test P-05 (SEC-044, CON-001): a connector URL is an operator-supplied address the server
 * will call, with the connector's bearer token attached. It must never reach the host's own
 * network.
 */

describe("P-05 connector URLs cannot aim the server at its own network", () => {
  it.each([
    "https://localhost/mcp",
    "https://localhost./mcp", // the trailing dot is the DNS root: still localhost
    "https://LOCALHOST../mcp",
    "https://metadata.google.internal/computeMetadata/v1/",
    "https://metadata.google.internal./",
    "https://intranet.corp/mcp",
    "https://printer.lan/mcp",
    "https://nas.home.arpa/mcp",
    "https://db.localdomain/",
    "https://127.0.0.1/mcp",
    "https://127.0.0.1./mcp",
    "https://0x7f.0.0.1/mcp", // the URL parser turns every spelling into 127.0.0.1
    "https://2130706433/mcp",
    "https://127.1/mcp",
    "https://169.254.169.254/latest/meta-data/",
    "https://[::1]/mcp",
    "https://[::ffff:127.0.0.1]/mcp",
    "https://user:pass@mcp.vendor.io/mcp",
    "http://mcp.vendor.io/mcp",
    "ftp://mcp.vendor.io/mcp",
    "https://singlelabel/mcp",
  ])("refuses %s", (url) => {
    expect(safeConnectorUrl(url)).toBe(false);
  });

  it("still accepts an ordinary public server", () => {
    expect(safeConnectorUrl("https://mcp.vendor.io/mcp")).toBe(true);
    expect(safeConnectorUrl("https://mcp.vendor.io:8443/v1/mcp?x=1")).toBe(true);
  });

  // The name check is only the first gate: a public-looking name can resolve to a private
  // address. Discovery connects through a guard that judges the address actually reached.
  it.each([
    "https://localhost/mcp", // resolves to 127.0.0.1 from /etc/hosts, no network needed
    "https://127.0.0.1/mcp",
    "https://169.254.169.254/latest/meta-data/",
    "https://[::1]/mcp",
    "https://[::ffff:10.0.0.1]/mcp",
  ])("never connects to %s, even if the name check were skipped", async (url) => {
    await expect(
      httpDiscovery(url, { kind: "bearer", token: "tok_secret_value_123" }),
    ).rejects.toThrow(/not allowed/);
  });
});

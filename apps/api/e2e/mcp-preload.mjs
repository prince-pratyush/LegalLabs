// Test only, loaded with `node --import`: requests the server makes to the public connector
// host go to a fake MCP server on loopback instead. The server's own code is unchanged, so the
// name check, the guarded client and the policy all run as they would; only the socket moves.
import http from "node:http";
import https from "node:https";

const fake = process.env.E2E_MCP_URL;
const real = https.request;

https.request = (url, options, callback) => {
  if (fake && url instanceof URL && url.hostname === "mcp.vendor.io") {
    const { lookup: _lookup, ...rest } = options;
    return http.request(new URL(url.pathname, fake), rest, callback);
  }
  return real(url, options, callback);
};

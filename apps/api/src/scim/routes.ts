import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { badRequest, ScimError } from "./errors.js";
import { project } from "./resources.js";
import {
  allSchemas,
  groupResource,
  RESOURCE_TYPE_URN,
  type ResourceDef,
  SPC_URN,
  schemaDocument,
  userResource,
} from "./schemas.js";
import { type Found, type ListQuery, MAX_COUNT, type Scim, type ScimContext } from "./service.js";

const TYPE = "application/scim+json; charset=utf-8";
const BEARER = /^Bearer (\S{10,200})$/i;

type Env = { Variables: { ctx: ScimContext } };

function resourceType(def: ResourceDef, base: string) {
  return {
    schemas: [RESOURCE_TYPE_URN],
    id: def.name,
    name: def.name,
    endpoint: def.endpoint,
    description: def.description,
    schema: def.core.id,
    schemaExtensions: def.extensions.map((e) => ({ schema: e.id, required: false })),
    meta: { resourceType: "ResourceType", location: `${base}/ResourceTypes/${def.name}` },
  };
}

const serviceProviderConfig = (base: string) => ({
  schemas: [SPC_URN],
  documentationUri: "https://github.com/",
  patch: { supported: true },
  bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
  filter: { supported: true, maxResults: MAX_COUNT },
  changePassword: { supported: false },
  sort: { supported: true },
  etag: { supported: true },
  authenticationSchemes: [
    {
      type: "oauthbearertoken",
      name: "OAuth Bearer Token",
      description: "A workspace API token with the scim scope, sent as a bearer token.",
      specUri: "https://www.rfc-editor.org/info/rfc6750",
      primary: true,
    },
  ],
  meta: { resourceType: "ServiceProviderConfig", location: `${base}/ServiceProviderConfig` },
});

export function scimRoutes(
  scim: Scim,
  clientOf: (c: Context) => { ip: string | null; userAgent: string | null },
) {
  const app = new Hono<Env>();
  const send = (
    c: Context,
    body: unknown,
    status: 200 | 201 | 400 = 200,
    headers: Record<string, string> = {},
  ) =>
    c.body(JSON.stringify(body), status, {
      "content-type": TYPE,
      "cache-control": "no-store",
      ...headers,
    });
  const base = (c: Context) => `${new URL(c.req.url).origin}/scim/v2`;

  app.onError((err, c) => {
    if (err instanceof ScimError) {
      const headers: Record<string, string> = { "content-type": TYPE, "cache-control": "no-store" };
      if (err.status === 401) headers["www-authenticate"] = 'Bearer realm="scim"';
      return c.body(JSON.stringify(err.body()), err.status as 400, headers);
    }
    // A database refusal means the principal lacked a right: say so without detail.
    if ((err as { code?: string }).code === "42501") {
      return c.body(JSON.stringify(new ScimError(403, undefined, "Not permitted.").body()), 403, {
        "content-type": TYPE,
      });
    }
    // The database keeps one active administrator, whatever the provider asks.
    if ((err as { message?: string }).message === "LAST_ADMIN") {
      return c.body(
        JSON.stringify(
          new ScimError(409, "mutability", "The last administrator cannot be removed.").body(),
        ),
        409,
        { "content-type": TYPE },
      );
    }
    console.error(`scim: ${err instanceof Error ? err.message : String(err)}`);
    return c.body(JSON.stringify(new ScimError(500, undefined, "Internal error.").body()), 500, {
      "content-type": TYPE,
    });
  });

  app.use(
    "*",
    bodyLimit({
      maxSize: 1_000_000,
      onError: (c) =>
        c.body(JSON.stringify(new ScimError(413, "tooMany", "Body too large.").body()), 413, {
          "content-type": TYPE,
        }),
    }),
  );

  app.use("*", async (c, next) => {
    const token = BEARER.exec(c.req.header("authorization") ?? "")?.[1];
    if (!token) throw new ScimError(401, undefined, "A bearer token is required.");
    const client = clientOf(c);
    const route = `${c.req.method} ${new URL(c.req.url).pathname.replace(/[0-9a-f-]{36}/g, ":id")}`;
    const auth = await scim.authenticate(token, client.ip, route);
    c.set("ctx", { ...auth, userAgent: client.userAgent, base: base(c) });
    await next();
  });

  const json = async (c: Context): Promise<unknown> => {
    const text = await c.req.text();
    try {
      return JSON.parse(text);
    } catch {
      throw badRequest("invalidSyntax", "The body is not valid JSON.");
    }
  };
  const ifMatch = (c: Context) => c.req.header("if-match");
  const found = (c: Context, f: Found, status: 200 | 201 = 200) => {
    const q = c.req.query();
    const doc = project(f.doc, q.attributes, q.excludedAttributes);
    const location = String((f.doc.meta as { location: string }).location);
    return send(c, doc, status, { etag: f.etag, location });
  };
  const read = (c: Context, f: Found) => {
    const given = c.req.header("if-none-match");
    if (given && given.replace(/^W\//, "") === f.etag.replace(/^W\//, "")) {
      return c.body(null, 304, { etag: f.etag });
    }
    return found(c, f);
  };
  const query = (c: Context): ListQuery => c.req.query();

  app.get("/ServiceProviderConfig", (c) => send(c, serviceProviderConfig(base(c))));
  app.get("/ResourceTypes", (c) => {
    const items = [userResource, groupResource].map((d) => resourceType(d, base(c)));
    return send(c, {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
      totalResults: items.length,
      startIndex: 1,
      itemsPerPage: items.length,
      Resources: items,
    });
  });
  app.get("/ResourceTypes/:id", (c) => {
    const def = [userResource, groupResource].find(
      (d) => d.name.toLowerCase() === c.req.param("id").toLowerCase(),
    );
    if (!def) throw new ScimError(404, undefined, "ResourceType not found.");
    return send(c, resourceType(def, base(c)));
  });
  app.get("/Schemas", (c) => {
    const items = allSchemas.map((s) => schemaDocument(s, base(c)));
    return send(c, {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
      totalResults: items.length,
      startIndex: 1,
      itemsPerPage: items.length,
      Resources: items,
    });
  });
  app.get("/Schemas/:id{.+}", (c) => {
    const s = allSchemas.find((x) => x.id.toLowerCase() === c.req.param("id").toLowerCase());
    if (!s) throw new ScimError(404, undefined, "Schema not found.");
    return send(c, schemaDocument(s, base(c)));
  });

  const mount = (path: string, svc: Scim["users"] | Scim["groups"]) => {
    app.get(path, async (c) => send(c, await svc.list(c.get("ctx"), query(c))));
    app.post(path, async (c) => found(c, await svc.create(c.get("ctx"), await json(c)), 201));
    app.get(`${path}/:id`, async (c) => read(c, await svc.get(c.get("ctx"), c.req.param("id"))));
    app.put(`${path}/:id`, async (c) =>
      found(c, await svc.replace(c.get("ctx"), c.req.param("id"), await json(c), ifMatch(c))),
    );
    app.patch(`${path}/:id`, async (c) =>
      found(c, await svc.patch(c.get("ctx"), c.req.param("id"), await json(c), ifMatch(c))),
    );
    app.delete(`${path}/:id`, async (c) => {
      await svc.remove(c.get("ctx"), c.req.param("id"), ifMatch(c));
      return c.body(null, 204);
    });
  };
  mount("/Users", scim.users);
  mount("/Groups", scim.groups);

  app.all("*", () => {
    throw new ScimError(404, undefined, "No such SCIM endpoint.");
  });
  return app;
}

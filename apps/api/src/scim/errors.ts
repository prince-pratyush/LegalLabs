export const ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";

export type ScimType =
  | "invalidFilter"
  | "tooMany"
  | "uniqueness"
  | "mutability"
  | "invalidSyntax"
  | "invalidPath"
  | "noTarget"
  | "invalidValue"
  | "invalidVers"
  | "sensitive";

/** An answer in RFC 7644 section 3.12 shape; the HTTP layer renders it. */
export class ScimError extends Error {
  constructor(
    readonly status: number,
    readonly scimType: ScimType | undefined,
    readonly detail: string,
  ) {
    super(detail);
  }

  body() {
    return {
      schemas: [ERROR_SCHEMA],
      status: String(this.status),
      ...(this.scimType ? { scimType: this.scimType } : {}),
      detail: this.detail,
    };
  }
}

export const badRequest = (type: ScimType, detail: string) => new ScimError(400, type, detail);

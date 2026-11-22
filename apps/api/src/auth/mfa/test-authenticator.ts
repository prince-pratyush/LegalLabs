import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isoCBOR } from "@simplewebauthn/server/helpers";

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest();

const UP = 0x01;
const UV = 0x04;
const AT = 0x40;

export interface AuthenticatorOptions {
  rpID: string;
  origin: string;
  /** Leave false to model a device that never checks the person (no PIN or biometric). */
  userVerifies?: boolean;
}

/**
 * A software WebAuthn authenticator: an ES256 key, "none" attestation and signed assertions,
 * built by hand so tests exercise the real verification path with no browser.
 */
export function createAuthenticator(options: AuthenticatorOptions) {
  const { rpID, origin, userVerifies = true } = options;
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const credentialId = randomBytes(32);
  let counter = 0;
  let userHandle: Uint8Array | undefined;
  const rpIdHash = sha256(rpID);
  const flags = UP | (userVerifies ? UV : 0);

  const clientData = (type: string, challenge: string, atOrigin = origin) =>
    Buffer.from(JSON.stringify({ type, challenge, origin: atOrigin, crossOrigin: false }));

  const counterBytes = (n: number) => {
    const out = Buffer.alloc(4);
    out.writeUInt32BE(n);
    return out;
  };

  return {
    credentialId: b64(credentialId),
    /** Overrides for what the next response claims, to test refusals. */
    set counter(next: number) {
      counter = next;
    },
    get counter() {
      return counter;
    },

    register(
      request: PublicKeyCredentialCreationOptionsJSON,
      tweak: { origin?: string; challenge?: string } = {},
    ): RegistrationResponseJSON {
      userHandle = Buffer.from(request.user.id, "base64url");
      const cose = isoCBOR.encode(
        new Map<number, number | Uint8Array>([
          [1, 2], // kty: EC2
          [3, -7], // alg: ES256
          [-1, 1], // crv: P-256
          [-2, Buffer.from(jwk.x ?? "", "base64url")],
          [-3, Buffer.from(jwk.y ?? "", "base64url")],
        ]),
      );
      const idLength = Buffer.alloc(2);
      idLength.writeUInt16BE(credentialId.length);
      const authData = Buffer.concat([
        rpIdHash,
        Buffer.from([flags | AT]),
        counterBytes(counter),
        Buffer.alloc(16), // AAGUID: none
        idLength,
        credentialId,
        cose,
      ]);
      const attestationObject = isoCBOR.encode(
        new Map<string, unknown>([
          ["fmt", "none"],
          ["attStmt", new Map()],
          ["authData", authData],
        ]) as Parameters<typeof isoCBOR.encode>[0],
      );
      return {
        id: b64(credentialId),
        rawId: b64(credentialId),
        type: "public-key",
        clientExtensionResults: {},
        authenticatorAttachment: "platform",
        response: {
          clientDataJSON: b64(
            clientData("webauthn.create", tweak.challenge ?? request.challenge, tweak.origin),
          ),
          attestationObject: b64(attestationObject),
          transports: ["internal"],
        },
      };
    },

    assert(
      request: PublicKeyCredentialRequestOptionsJSON,
      tweak: { origin?: string; challenge?: string; sendHandle?: boolean } = {},
    ): AuthenticationResponseJSON {
      counter += 1;
      const authData = Buffer.concat([rpIdHash, Buffer.from([flags]), counterBytes(counter)]);
      const data = clientData("webauthn.get", tweak.challenge ?? request.challenge, tweak.origin);
      const signature = sign("sha256", Buffer.concat([authData, sha256(data)]), privateKey);
      return {
        id: b64(credentialId),
        rawId: b64(credentialId),
        type: "public-key",
        clientExtensionResults: {},
        authenticatorAttachment: "platform",
        response: {
          clientDataJSON: b64(data),
          authenticatorData: b64(authData),
          signature: b64(signature),
          ...(tweak.sendHandle !== false && userHandle ? { userHandle: b64(userHandle) } : {}),
        },
      };
    },
  };
}

import { z } from "zod";
import { createCapLoader } from "./cap.js";
import { createCourtListenerLoader } from "./courtlistener.js";
import { createEdgarLoader } from "./edgar.js";
import { createEurLexLoader } from "./eurlex.js";
import type { Loader, SourceId } from "./sources.js";

/** Identifiers only: the repository never carries the documents themselves. */
export const subsetSchema = z.strictObject({
  us_caselaw: z.strictObject({ cites: z.array(z.string().min(1).max(100)).max(10_000) }).optional(),
  eurlex: z
    .strictObject({
      celex: z.array(z.string().regex(/^[0-9CE]\d{4}[A-Z]{1,2}\d{4}$/)).max(10_000),
    })
    .optional(),
  edgar: z
    .strictObject({
      companies: z
        .array(
          z.strictObject({
            cik: z.string().regex(/^\d{1,10}$/),
            forms: z.array(z.string().min(1).max(20)).min(1).max(20),
            limit: z.number().int().min(1).max(100),
          }),
        )
        .max(10_000),
    })
    .optional(),
});
export type Subset = z.infer<typeof subsetSchema>;

/** A small, well-known starting set: a few MB once indexed. */
export const DEFAULT_SUBSET: Subset = {
  us_caselaw: {
    cites: [
      "5 U.S. 137",
      "326 U.S. 310",
      "347 U.S. 483",
      "376 U.S. 254",
      "384 U.S. 436",
      "410 U.S. 113",
      "444 U.S. 286",
      "467 U.S. 837",
      "471 U.S. 462",
      "477 U.S. 242",
      "477 U.S. 317",
      "485 U.S. 224",
      "509 U.S. 579",
      "531 U.S. 98",
      "544 U.S. 336",
      "547 U.S. 388",
      "550 U.S. 398",
      "550 U.S. 544",
      "551 U.S. 308",
      "556 U.S. 662",
      "558 U.S. 310",
      "559 U.S. 77",
      "563 U.S. 333",
      "564 U.S. 338",
      "564 U.S. 915",
      "571 U.S. 117",
    ],
  },
  eurlex: {
    celex: [
      "32016R0679",
      "31995L0046",
      "32002L0058",
      "32000L0031",
      "32011L0083",
      "32019L0790",
      "32008R0593",
      "32012R1215",
      "32022R2065",
      "32022R1925",
      "62012CJ0131",
      "62014CJ0362",
      "62018CJ0311",
    ],
  },
  edgar: {
    companies: [
      { cik: "320193", forms: ["10-K"], limit: 1 },
      { cik: "789019", forms: ["10-K"], limit: 1 },
      { cik: "1318605", forms: ["8-K"], limit: 2 },
    ],
  },
};

export interface LoaderEnv {
  COURTLISTENER_TOKEN?: string | undefined;
  SEC_USER_AGENT?: string | undefined;
}

/** CourtListener when the deployment has a token, else the CAP snapshot, which needs none. */
export function loaderFor(source: SourceId, subset: Subset, env: LoaderEnv): Loader | null {
  switch (source) {
    case "us_caselaw": {
      const cites = subset.us_caselaw?.cites ?? [];
      return env.COURTLISTENER_TOKEN
        ? createCourtListenerLoader({ cites, token: env.COURTLISTENER_TOKEN })
        : createCapLoader({ cites });
    }
    case "eurlex":
      return createEurLexLoader({ celex: subset.eurlex?.celex ?? [] });
    case "edgar":
      if (!env.SEC_USER_AGENT) return null;
      return createEdgarLoader({
        companies: subset.edgar?.companies ?? [],
        userAgent: env.SEC_USER_AGENT,
      });
  }
}

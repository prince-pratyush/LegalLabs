import { CFR_SECTION, CFR_TITLE, createEcfrLoader } from "./ecfr.js";
import { createFederalRegisterLoader, FR_DOCUMENT_NUMBER } from "./fr.js";
import { createHttp, type Http } from "./http.js";
import type { ScannerOptions, ScanSourceId } from "./scan.js";
import { isFailure, type Loader } from "./sources.js";
import { createUkLegislationLoader, UK_TYPES, ukHttp } from "./uk.js";

// The full text of one item a scan found, read with that source's own loader. The name is
// checked first, so nothing but the source's own host and paths is ever asked.

const ECFR_ID = /^([^/]+)\/([^@]+)@(\d{4}-\d{2}-\d{2})$/;
const UK_ID = /^([a-z]{2,6})\/(\d{4})\/(\d{1,6})$/;

function loaderOf(source: ScanSourceId, externalId: string, http: Http): Loader | null {
  if (source === "fr") {
    return FR_DOCUMENT_NUMBER.test(externalId)
      ? createFederalRegisterLoader({ documents: [externalId], http })
      : null;
  }
  if (source === "ecfr") {
    const [, title = "", section = "", asOf = ""] = ECFR_ID.exec(externalId) ?? [];
    return CFR_TITLE.test(title) && CFR_SECTION.test(section)
      ? createEcfrLoader({ sections: [{ title, section }], asOf, http })
      : null;
  }
  const [, type = "", year, number] = UK_ID.exec(externalId) ?? [];
  return (UK_TYPES as readonly string[]).includes(type)
    ? createUkLegislationLoader({
        items: [{ type, year: Number(year), number: Number(number) }],
        http,
      })
    : null;
}

export type ItemText = (source: ScanSourceId, externalId: string) => Promise<string | null>;

/** Null when the source has no text to give just now. */
export function createItemText(options: ScannerOptions = {}): ItemText {
  const { userAgent } = options;
  const clients = new Map<ScanSourceId, Http>();
  const client = (source: ScanSourceId) => {
    let http = clients.get(source);
    if (!http) {
      http =
        options.http?.(source) ??
        (source === "uk_legislation"
          ? ukHttp(userAgent)
          : createHttp({ perSecond: 1, userAgent, timeoutMs: 20_000, retries: 1 }));
      clients.set(source, http);
    }
    return http;
  };
  return async (source, externalId) => {
    const loader = loaderOf(source, externalId, client(source));
    if (!loader) return null;
    for await (const record of loader.records()) {
      if (isFailure(record)) return null;
      return record.chunks.map((chunk) => chunk.text).join("\n\n");
    }
    return null;
  };
}

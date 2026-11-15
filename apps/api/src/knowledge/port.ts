import type { AuthorityPassage, KnowledgePort } from "@legallabs/contracts";
import { isSourceId } from "@legallabs/knowledge";
import { type Knowledge, parseFilter, type SourceFilter } from "./knowledge.js";

/** The knowledge store as threads see it, through the port they were built against. */
export function knowledgePort(knowledge: Knowledge): KnowledgePort {
  return {
    async list(caller) {
      const sources = await knowledge.sources(caller);
      return (sources ?? []).map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.group,
        jurisdiction: s.jurisdiction,
      }));
    },

    async search(caller, sources, query, limit) {
      // Other kinds of source, and filters that don't fit, are left to their own ports.
      const picked: SourceFilter[] = [];
      for (const s of sources) {
        const filter = s.filter ?? {};
        if (isSourceId(s.source_id) && parseFilter(s.source_id, filter) !== null) {
          picked.push({ sourceId: s.source_id, filter });
        }
      }
      if (picked.length === 0) return [];
      const passages = await knowledge.search(caller, query, picked, limit);
      return (passages ?? []).map(
        (p): AuthorityPassage => ({
          authority_id: p.authorityRef,
          source_id: p.source,
          // The string the model should cite, which the verifier looks up again.
          citation_string: p.citation ?? p.authorityRef,
          title: p.title,
          url: p.url ?? `/knowledge/authorities/${encodeURIComponent(p.authorityRef)}`,
          ...(p.sectionPath ? { pin: p.sectionPath } : {}),
          text: p.text,
        }),
      );
    },
  };
}

import { type ClassifyOption, type ExportBody, RT_LIMITS } from "@legallabs/contracts";
import type pg from "pg";
import type { Client, Principal } from "../auth/auth.js";
import { asApp } from "../db.js";
import { audit } from "./audit.js";
import { cellJson } from "./cells.js";
import { rowsSql, UnknownColumn } from "./query.js";
import { fail, loadColumns, loadTable, type Result, rowsJson, settingsOf } from "./tables.js";
import { buildXlsx, type XlsxCell } from "./xlsx.js";

// Bigger tables need export jobs, which aren't built yet (spec §3.8: 2,000 cells synchronously).
export const MAX_EXPORT_CELLS = RT_LIMITS.syncExportCells;

const VERIFIED_FILL = "C6EFCE";
const COLORS: Record<string, string> = {
  red: "FFC7CE",
  orange: "FFD8B1",
  yellow: "FFEB9C",
  green: "C6EFCE",
  blue: "BDD7EE",
  purple: "D9C3E9",
  teal: "B7E1DD",
  gray: "D9D9D9",
};

export interface ExportFile {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}

/** A field a spreadsheet could run as a formula gets a leading quote, unless it's a plain number. */
export function csvSafe(text: string): string {
  if (/^-?[\d,]+(\.\d+)?$/.test(text)) return text;
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

const csvField = (text: string) => {
  const safe = csvSafe(text);
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};

export function createExports(pool: pg.Pool, { maxCells = MAX_EXPORT_CELLS as number } = {}) {
  return {
    run(
      principal: Principal,
      tableId: string,
      body: ExportBody,
      client: Client,
    ): Promise<Result<ExportFile>> {
      return asApp(pool, principal, async (db) => {
        const table = await loadTable(db, tableId);
        if (!table) return fail("NOT_FOUND");
        if (table.vault_id) {
          // The source vault's content controls bind everyone but its owner.
          const { rows } = await db.query<{
            level: string | null;
            controls: Record<string, boolean>;
          }>(
            "select content.vault_level(id) level, content_controls controls from content.vault where id = $1",
            [table.vault_id],
          );
          const vault = rows[0];
          if (
            !vault ||
            (vault.level !== "owner" &&
              (vault.controls.allow_download === false || vault.controls.allow_duplicate === false))
          ) {
            return fail("EXPORT_DISABLED_BY_SOURCE", "The source vault doesn't allow exports.");
          }
        }
        const all = await loadColumns(db, tableId);
        const columns = body.only_columns
          ? all.filter((c) => body.only_columns?.includes(c.id))
          : all;
        let built: { sql: string; params: unknown[] };
        try {
          built = rowsSql({
            tableId,
            columns: new Map(all.map((c) => [c.id, c.type])),
            filter: body.only_filtered_rows,
          });
        } catch (err) {
          if (err instanceof UnknownColumn)
            return fail("INVALID_REQUEST", "That column isn't in this table.");
          throw err;
        }
        const { rows: rowRecords } = await db.query(built.sql, built.params);
        if (rowRecords.length * Math.max(columns.length, 1) > maxCells) {
          return fail(
            "EXPORT_TOO_LARGE",
            `This export has more than ${maxCells.toLocaleString("en")} cells. Filter the rows or pick fewer columns.`,
            { limit: maxCells },
          );
        }
        const rows = await rowsJson(db, rowRecords as never);
        const visible = rows.filter((r) => !r.restricted).map((r) => r.id);
        const { rows: cellRecords } = await db.query(
          "select * from work.rt_cell where row_id = any($1::uuid[]) and column_id = any($2::uuid[])",
          [visible, columns.map((c) => c.id)],
        );
        const byColumn = new Map(columns.map((c) => [c.id, c]));
        const cells = new Map(
          cellRecords.map((c) => {
            const cell = cellJson(
              c as never,
              table,
              byColumn.get((c as { column_id: string }).column_id),
            );
            return [`${cell.row_id}:${cell.column_id}`, cell];
          }),
        );
        const settings = settingsOf(table);
        const citations: string[][] = [];
        if (body.include_citations && cellRecords.length > 0) {
          const { rows: cites } = await db.query<{
            row_id: string;
            column_id: string;
            name: string;
            page_no: number | null;
            quote: string;
            status: string;
          }>(
            `select c.row_id, c.column_id, d.name, x.page_no, x.quote, x.status
               from work.rt_cell_citation x join work.rt_cell c on c.id = x.cell_id
               join content.document_version v on v.id = x.version_id
               join content.document d on d.id = v.document_id
              where x.cell_id = any($1::uuid[]) order by c.row_id, c.column_id, x.ordinal`,
            [cellRecords.map((c) => (c as { id: string }).id)],
          );
          for (const c of cites) {
            citations.push([
              c.name,
              byColumn.get(c.column_id)?.label ?? "",
              c.page_no === null ? "" : String(c.page_no),
              c.quote,
              c.status === "ok" ? "verified" : "unverified",
            ]);
          }
        }

        const header = [
          "Document",
          ...columns.flatMap((c) =>
            body.include_reasoning ? [c.label, `${c.label} (reasoning)`] : [c.label],
          ),
        ];
        const grid: XlsxCell[][] = [header.map((text) => ({ text, bold: true }))];
        for (const row of rows) {
          const name = row.documents.map((d) => d.name).join("; ");
          const line: XlsxCell[] = [{ text: name }];
          for (const column of columns) {
            const cell = row.restricted ? undefined : cells.get(`${row.id}:${column.id}`);
            const text =
              cell?.status === "done"
                ? (cell.value_text ?? "")
                : cell?.status === "null"
                  ? settings.null_display
                  : "";
            let fill: string | undefined;
            if (body.highlight_verified && cell?.verified_at) fill = VERIFIED_FILL;
            else if (body.highlight_flagged && cell?.flag_color) fill = COLORS[cell.flag_color];
            else if (body.classify_colors && cell?.value_typed?.kind === "classify") {
              const option = ((column.options.options as ClassifyOption[] | undefined) ?? []).find(
                (o) => o.id === (cell.value_typed as { option_ids: string[] }).option_ids[0],
              );
              fill = option ? COLORS[option.color] : undefined;
            }
            line.push({ text, fill });
            if (body.include_reasoning) line.push({ text: cell?.reasoning ?? "" });
          }
          grid.push(line);
        }

        await audit(db, principal, client, "table.export", tableId, {
          format: body.format,
          rows: rows.length,
          columns: columns.length,
          options: {
            include_reasoning: body.include_reasoning,
            include_citations: body.include_citations,
            highlight_verified: body.highlight_verified,
            classify_colors: body.classify_colors,
            filtered: body.only_filtered_rows !== undefined,
          },
        });
        const base =
          table.name
            .replace(/[^\p{L}\p{N} _.-]+/gu, "")
            .trim()
            .slice(0, 80) || "review";
        if (body.format === "csv") {
          const lines = grid.map((line) => line.map((c) => csvField(c.text)).join(","));
          if (body.include_citations) {
            lines.push(
              "",
              "Citations",
              ["Document", "Column", "Page", "Quote", "Status"].join(","),
            );
            for (const c of citations) lines.push(c.map(csvField).join(","));
          }
          return {
            ok: true,
            value: {
              filename: `${base}.csv`,
              contentType: "text/csv; charset=utf-8",
              bytes: new TextEncoder().encode(`﻿${lines.join("\r\n")}\r\n`),
            },
          };
        }
        const sheets = [{ name: "Table", rows: grid }];
        if (body.include_citations) {
          sheets.push({
            name: "Citations",
            rows: [
              ["Document", "Column", "Page", "Quote", "Status"].map((text) => ({
                text,
                bold: true,
              })),
              ...citations.map((c) => c.map((text) => ({ text }))),
            ],
          });
        }
        return {
          ok: true,
          value: {
            filename: `${base}.xlsx`,
            contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            bytes: buildXlsx(sheets),
          },
        };
      });
    },
  };
}

export type Exports = ReturnType<typeof createExports>;

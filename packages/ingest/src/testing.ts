const escapeText = (text: string) => text.replace(/[\\()]/g, (char) => `\\${char}`);

export interface TestPdfOptions {
  /** Adds a password dictionary no empty password can open. */
  encrypted?: boolean;
}

/** One array of lines per page. An empty string leaves a blank line, starting a new paragraph. */
export function makePdf(pages: readonly (readonly string[])[], options: TestPdfOptions = {}) {
  const objects: string[] = [];
  const add = (body: string) => objects.push(body);
  const pageId = (index: number) => 4 + index * 2;

  add("<< /Type /Catalog /Pages 2 0 R >>");
  add(
    `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${pageId(i)} 0 R`).join(" ")}] >>`,
  );
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  pages.forEach((lines, index) => {
    let y = 720;
    const shown = lines.map((line) => {
      const here = y;
      y -= 14;
      return line === "" ? "" : `BT /F1 12 Tf 72 ${here} Td (${escapeText(line)}) Tj ET`;
    });
    const stream = shown.join("\n");
    add(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${pageId(index) + 1} 0 R ` +
        "/Resources << /Font << /F1 3 0 R >> >> >>",
    );
    add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });

  let trailerExtra = "";
  if (options.encrypted) {
    const fill = "00".repeat(32);
    add(`<< /Filter /Standard /V 1 /R 2 /O <${fill}> /U <${fill}> /P -4 >>`);
    trailerExtra = ` /Encrypt ${objects.length} 0 R /ID [<00><00>]`;
  }

  let body = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const offset = body.length;
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${trailerExtra} >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(body, "latin1"));
}

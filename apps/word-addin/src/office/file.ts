/** The open document as .docx bytes, read slice by slice as Office hands it over. */
export function readFile(): Promise<Uint8Array<ArrayBuffer>> {
  return new Promise((resolve, reject) => {
    Office.context.document.getFileAsync(
      Office.FileType.Compressed,
      { sliceSize: 4 * 1024 * 1024 },
      (opened) => {
        if (opened.status !== Office.AsyncResultStatus.Succeeded) {
          reject(new Error(opened.error.message));
          return;
        }
        const file = opened.value;
        const parts: Uint8Array[] = [];
        const next = (index: number) => {
          if (index === file.sliceCount) {
            file.closeAsync();
            const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
            let at = 0;
            for (const part of parts) {
              out.set(part, at);
              at += part.length;
            }
            resolve(out);
            return;
          }
          file.getSliceAsync(index, (slice) => {
            if (slice.status !== Office.AsyncResultStatus.Succeeded) {
              file.closeAsync();
              reject(new Error(slice.error.message));
              return;
            }
            parts.push(new Uint8Array(slice.value.data as number[]));
            next(index + 1);
          });
        };
        next(0);
      },
    );
  });
}

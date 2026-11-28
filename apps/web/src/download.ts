/**
 * Hands the browser a file to save, without leaving the page. The link is in the
 * document while clicked, and the URL lives until the browser has taken the file.
 */
export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** What the viewer needs from a PDF engine, so stories and tests can paint without pdf.js. */
export interface PdfDocument {
  renderPage(
    pageNo: number,
    canvas: HTMLCanvasElement,
    scale: number,
    signal: AbortSignal,
  ): Promise<void>;
  destroy(): void;
}

export type PdfLoader = (url: string) => Promise<PdfDocument>;

let workerPort: Worker | null = null;

/** The app supplies the worker, because only its bundler knows where the worker file ends up. */
export function setPdfWorker(worker: Worker) {
  workerPort = worker;
}

// Small chunks: a citation deep in a long file should cost a few requests, not the whole file.
const CHUNK = 64 * 1024;

let engine: Promise<typeof import("pdfjs-dist")> | null = null;

// Loaded on first use, so screens without a PDF never download pdf.js.
function pdfEngine() {
  engine ??= import("pdfjs-dist").catch((err: unknown) => {
    engine = null;
    throw err;
  });
  return engine;
}

/** Starts fetching pdf.js early, while the document's details are still loading. */
export function preloadPdf() {
  pdfEngine().catch(() => {});
}

export const loadPdf: PdfLoader = async (url) => {
  const pdfjs = await pdfEngine();
  if (workerPort) pdfjs.GlobalWorkerOptions.workerPort = workerPort;
  const task = pdfjs.getDocument({
    url,
    withCredentials: true,
    disableAutoFetch: true,
    disableStream: true,
    rangeChunkSize: CHUNK,
  });
  const document = await task.promise;
  return {
    async renderPage(pageNo, canvas, scale, signal) {
      const page = await document.getPage(pageNo);
      if (signal.aborted) return;
      const ratio = globalThis.devicePixelRatio || 1;
      const viewport = page.getViewport({ scale: scale * ratio });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const render = page.render({ canvas, viewport });
      signal.addEventListener("abort", () => render.cancel(), { once: true });
      try {
        await render.promise;
      } catch (err) {
        // Scrolling past a page cancels its paint; that isn't an error.
        if ((err as { name?: string }).name !== "RenderingCancelledException") throw err;
      } finally {
        page.cleanup();
      }
    },
    destroy() {
      void task.destroy();
    },
  };
};

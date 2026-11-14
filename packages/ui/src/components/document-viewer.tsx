import type { Anchor, DocumentHit, PageLayout, RenderManifest } from "@legallabs/contracts";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronLeft, ChevronRight, Minus, PanelLeft, Plus, Search, X } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "../cn.js";
import { locateQuote, rectsFor } from "../viewer/highlight.js";
import { loadPdf as defaultLoadPdf, type PdfDocument, type PdfLoader } from "../viewer/pdf.js";
import {
  EmailPage,
  isTranscript,
  MARK_STYLES,
  type Mark,
  SheetPage,
  TextPage,
  TranscriptPage,
} from "../viewer/views.js";
import { Button } from "./button.js";
import { Skeleton, StatusText } from "./status.js";
import { Tooltip } from "./tooltip.js";

/** Where the viewer gets a version's data. The app wires it to the API; stories fake it. */
export interface ViewerSource {
  manifest(): Promise<RenderManifest>;
  pages(from: number, to: number): Promise<PageLayout[]>;
  search(query: string): Promise<DocumentHit[]>;
}

export interface ViewerTarget {
  page: number;
  char_from?: number | null;
  char_to?: number | null;
  quote?: string | null;
  status?: Anchor["status"];
}

export interface DocumentViewerProps {
  source: ViewerSource;
  /** Where to open. Without a span it opens at the page. */
  target?: ViewerTarget | undefined;
  /** The citations to step through with j and k; `index` is the one shown. */
  anchors?: readonly Anchor[];
  index?: number;
  /** Shows another citation, which may be in another document. */
  onStep?: ((index: number) => void) | undefined;
  onClose?: (() => void) | undefined;
  onOpenAttachment?: ((attachment: RenderManifest["attachments"][number]) => void) | undefined;
  /** "Where this came from": a link back to the thread, cell or fact. */
  origin?: ReactNode;
  loadPdf?: PdfLoader;
}

const CHUNK = 20;
const GAP = 16;
const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const TEXT_PAGE = 900;

type Load =
  | { state: "loading" }
  | { state: "ready"; manifest: RenderManifest }
  | { state: "error"; message: string };

// Walled and missing look the same, so the viewer can't reveal that a document exists.
const errorMessage = (err: unknown) =>
  (err as { status?: number }).status === 404
    ? "This document wasn't found, or you don't have access to it."
    : "The document couldn't be loaded. Try again.";

const zoomIn = (scale: number) => ZOOMS.find((z) => z > scale + 0.01) ?? scale;
const zoomOut = (scale: number) => [...ZOOMS].reverse().find((z) => z < scale - 0.01) ?? scale;

/** Page layouts, fetched twenty pages at a time as they come into view. */
function useLayouts(source: ViewerSource, pageCount: number) {
  const [layouts, setLayouts] = useState<ReadonlyMap<number, PageLayout>>(new Map());
  const asked = useRef(new Set<number>());
  const want = useCallback(
    (page: number) => {
      const chunk = Math.floor((page - 1) / CHUNK);
      if (page < 1 || page > pageCount || asked.current.has(chunk)) return;
      asked.current.add(chunk);
      const from = chunk * CHUNK + 1;
      source.pages(from, Math.min(from + CHUNK - 1, pageCount)).then(
        (pages) =>
          setLayouts((old) => {
            const next = new Map(old);
            for (const page of pages) next.set(page.page_no, page);
            return next;
          }),
        // A later scroll asks again.
        () => asked.current.delete(chunk),
      );
    },
    [source, pageCount],
  );
  return { layouts, want };
}

function marksFor(
  page: PageLayout | undefined,
  target: ViewerTarget | undefined,
  hits: readonly DocumentHit[],
) {
  const marks: Mark[] = [];
  let missed = false;
  if (page && target && target.page === page.page_no) {
    const quote = target.quote ?? page.text.slice(target.char_from ?? 0, target.char_to ?? 0);
    const label = `Cited text: ${quote}`;
    const verified =
      target.status !== "mismatch" && target.char_from != null && target.char_to != null;
    if (verified) {
      marks.push({ from: target.char_from ?? 0, to: target.char_to ?? 0, kind: "cite", label });
    } else if (target.quote) {
      const found = locateQuote(page.text, target.quote);
      if (found) {
        marks.push({
          from: found.from,
          to: found.to,
          kind: found.exact && target.status !== "mismatch" ? "cite" : "approx",
          label: `Approximate match. ${label}`,
        });
      } else {
        missed = true;
      }
    }
  }
  if (page) {
    for (const hit of hits) {
      if (hit.page === page.page_no) {
        marks.push({ from: hit.char_from, to: hit.char_to, kind: "hit", label: "Search match" });
      }
    }
  }
  return { marks, missed };
}

/** One viewer for every kind of file, opened at a citation with the quoted span highlighted. */
export function DocumentViewer({
  source,
  target,
  anchors = [],
  index = 0,
  onStep,
  onClose,
  onOpenAttachment,
  origin,
  loadPdf = defaultLoadPdf,
}: DocumentViewerProps) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  useEffect(() => {
    let live = true;
    setLoad({ state: "loading" });
    source.manifest().then(
      (manifest) => live && setLoad({ state: "ready", manifest }),
      (err) => live && setLoad({ state: "error", message: errorMessage(err) }),
    );
    return () => {
      live = false;
    };
  }, [source]);

  if (load.state === "loading") return <ViewerSkeleton />;
  if (load.state === "error") {
    return (
      <ViewerFrame title="Document" onClose={onClose}>
        <p role="alert" className="p-6">
          <StatusText tone="failed">{load.message}</StatusText>
        </p>
      </ViewerFrame>
    );
  }
  const { manifest } = load;
  if (manifest.status !== "indexed") {
    const failed = manifest.status === "failed";
    return (
      <ViewerFrame title={manifest.name} onClose={onClose}>
        <p role="status" className="p-6">
          <StatusText tone={failed ? "failed" : "running"}>
            {failed
              ? "This document couldn't be read, so it can't be shown."
              : "This document is still being read. It opens here when it's ready."}
          </StatusText>
        </p>
      </ViewerFrame>
    );
  }
  return (
    <LoadedViewer
      manifest={manifest}
      source={source}
      target={target}
      anchors={anchors}
      index={index}
      onStep={onStep}
      onClose={onClose}
      onOpenAttachment={onOpenAttachment}
      origin={origin}
      loadPdf={loadPdf}
    />
  );
}

function ViewerFrame({
  title,
  onClose,
  children,
  tools,
}: {
  title: string;
  onClose: (() => void) | undefined;
  children: ReactNode;
  tools?: ReactNode;
}) {
  return (
    <section
      aria-label={`Document viewer: ${title}`}
      className="flex h-full min-h-0 flex-col bg-bg-subtle text-fg"
    >
      <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b border-border bg-bg px-3 py-1">
        <h2 className="min-w-0 flex-1 truncate text-section font-semibold">{title}</h2>
        {tools}
        {onClose ? (
          <Tooltip content="Close viewer" shortcut="Esc">
            <Button variant="quiet" size="icon" aria-label="Close viewer" onClick={onClose}>
              <X aria-hidden />
            </Button>
          </Tooltip>
        ) : null}
      </header>
      {children}
    </section>
  );
}

/** The viewer's loading state, shown until the document's manifest arrives. */
export function ViewerSkeleton() {
  return (
    <section
      aria-label="Document viewer"
      aria-busy="true"
      className="flex h-full flex-col bg-bg-subtle"
    >
      <div className="flex h-12 items-center gap-3 border-b border-border bg-bg px-3">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="ml-auto h-4 w-24" />
      </div>
      <div className="grid justify-center gap-4 p-6">
        <Skeleton className="h-[60vh] w-[min(640px,80vw)]" />
      </div>
      <p className="sr-only" role="status">
        Loading document…
      </p>
    </section>
  );
}

type LoadedProps = Omit<DocumentViewerProps, "anchors" | "index" | "loadPdf"> & {
  manifest: RenderManifest;
  anchors: readonly Anchor[];
  index: number;
  loadPdf: PdfLoader;
};

function LoadedViewer({
  manifest,
  source,
  target: requested,
  anchors,
  index,
  onStep,
  onClose,
  onOpenAttachment,
  origin,
  loadPdf,
}: LoadedProps) {
  const count = manifest.pages.length;
  const kind = manifest.render;
  const target =
    requested && requested.page >= 1 && requested.page <= count ? requested : undefined;
  const { layouts, want } = useLayouts(source, count);
  const scroller = useRef<HTMLElement>(null);
  const pageInput = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const [width, setWidth] = useState(800);
  const [zoom, setZoom] = useState<number | null>(null);
  const [strip, setStrip] = useState(false);
  const [current, setCurrent] = useState(target?.page ?? 1);
  const [sheetPage, setSheetPage] = useState(target?.page ?? 1);
  const [announce, setAnnounce] = useState("");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<readonly DocumentHit[]>([]);
  const [hitIndex, setHitIndex] = useState(-1);
  const [searching, setSearching] = useState(false);
  const [pdf, setPdf] = useState<PdfDocument | null>(null);
  const [pdfFailed, setPdfFailed] = useState(false);

  useEffect(() => {
    const element = scroller.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 800));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (kind !== "pdf" || !manifest.file_url) return;
    let doc: PdfDocument | null = null;
    let live = true;
    loadPdf(manifest.file_url).then(
      (loaded) => {
        doc = loaded;
        if (live) setPdf(loaded);
        else loaded.destroy();
      },
      () => live && setPdfFailed(true),
    );
    return () => {
      live = false;
      doc?.destroy();
    };
  }, [kind, manifest.file_url, loadPdf]);

  // Fits the widest page to the pane until the user zooms.
  const widest = Math.max(1, ...manifest.pages.map((p) => p.width));
  const fit = Math.min(2, Math.max(0.25, (width - 2 * GAP) / widest));
  const scale = zoom ?? fit;
  // A PDF that won't load still reads as text, so a citation always has somewhere to land.
  const paged = kind === "pdf" && !pdfFailed;
  const sheet = kind === "sheet";
  const pageHeight = useCallback(
    (i: number) => (paged ? (manifest.pages[i]?.height ?? 792) * scale : TEXT_PAGE) + GAP,
    [paged, manifest.pages, scale],
  );

  // PDF page sizes are known up front, so a page's offset is exact before anything paints.
  const tops = useMemo(() => {
    const out = [GAP];
    for (let i = 0; i < count; i++) out.push((out[i] ?? 0) + pageHeight(i));
    return out;
  }, [count, pageHeight]);

  const virtual = useVirtualizer({
    count: sheet ? 0 : count,
    getScrollElement: () => scroller.current,
    estimateSize: pageHeight,
    overscan: 1,
    paddingStart: GAP,
    // Starts at the cited page, so the first paint is that page and not page 1.
    initialOffset: () => (paged && target ? (tops[target.page - 1] ?? 0) : 0),
  });
  const items = virtual.getVirtualItems();

  useEffect(() => {
    if (scale > 0) virtual.measure();
  }, [virtual, scale]);

  // Asks for the layouts of pages in view, and tracks which page is on screen.
  useEffect(() => {
    for (const item of items) want(item.index + 1);
    const top = scroller.current?.scrollTop ?? 0;
    const first = items.find((item) => item.end - top > 80);
    if (first) setCurrent(first.index + 1);
  }, [items, want]);

  useEffect(() => {
    if (sheet) want(sheetPage);
  }, [sheet, sheetPage, want]);

  const goTo = useCallback(
    (page: number, offset = 0) => {
      const clamped = Math.min(Math.max(1, page), count);
      if (sheet) {
        setSheetPage(clamped);
        return;
      }
      want(clamped);
      const start = paged
        ? (tops[clamped - 1] ?? 0)
        : (virtual.getOffsetForIndex(clamped - 1, "start")?.[0] ?? 0);
      virtual.scrollToOffset(Math.max(0, start + offset));
      setCurrent(clamped);
    },
    [count, sheet, virtual, want, paged, tops],
  );

  // Opens at the target page first, then settles the highlight into the upper third.
  const settled = useRef<ViewerTarget | null>(null);
  useEffect(() => {
    if (!target || settled.current === target) return;
    const layout = layouts.get(target.page);
    if (!layout) {
      goTo(target.page);
      return;
    }
    settled.current = target;
    const mark = marksFor(layout, target, []).marks[0];
    const rect = mark && paged ? rectsFor(layout.lines, mark.from, mark.to)[0] : undefined;
    if (rect) {
      goTo(target.page, rect.y * scale - (scroller.current?.clientHeight ?? 600) / 3);
      return;
    }
    goTo(target.page);
    requestAnimationFrame(() =>
      scroller.current
        ?.querySelector("[data-mark='cite'],[data-mark='approx']")
        ?.scrollIntoView?.({ block: "center" }),
    );
  }, [target, layouts, goTo, paged, scale]);

  const step = useCallback(
    (delta: number) => {
      if (anchors.length === 0 || !onStep) return;
      onStep((index + delta + anchors.length) % anchors.length);
    },
    [anchors.length, index, onStep],
  );

  useEffect(() => {
    if (anchors.length > 0) setAnnounce(`Citation ${index + 1} of ${anchors.length}`);
  }, [anchors.length, index]);

  const runSearch = async () => {
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    try {
      const found = await source.search(q);
      setHits(found);
      setHitIndex(found.length ? 0 : -1);
      setAnnounce(found.length ? `${found.length} matches` : "No matches");
      if (found[0]) goTo(found[0].page);
    } catch {
      setAnnounce("Search failed. Try again.");
    } finally {
      setSearching(false);
    }
  };

  const stepHit = (delta: number) => {
    if (!hits.length) return;
    const next = (hitIndex + delta + hits.length) % hits.length;
    const hit = hits[next];
    setHitIndex(next);
    if (hit) goTo(hit.page);
    setAnnounce(`Match ${next + 1} of ${hits.length}, page ${hit?.page}`);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const element = event.target as HTMLElement;
    const typing = element.closest("input,textarea,select,[contenteditable]");
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
      event.preventDefault();
      searchInput.current?.focus();
      return;
    }
    if (event.key === "Escape") {
      if (typing) scroller.current?.focus();
      else onClose?.();
      return;
    }
    if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
    const actions: Record<string, () => void> = {
      j: () => step(1),
      "]": () => step(1),
      k: () => step(-1),
      "[": () => step(-1),
      g: () => pageInput.current?.focus(),
      "/": () => searchInput.current?.focus(),
      t: () => setStrip((open) => !open),
      "+": () => setZoom(zoomIn(scale)),
      "=": () => setZoom(zoomIn(scale)),
      "-": () => setZoom(zoomOut(scale)),
      "0": () => setZoom(null),
    };
    const action = actions[event.key];
    if (action) {
      event.preventDefault();
      action();
    }
  };

  const shownPage = sheet ? sheetPage : current;
  const missed = target ? marksFor(layouts.get(target.page), target, []).missed : false;
  const citedPages = useMemo(() => new Set(anchors.map((a) => a.page)), [anchors]);
  const hitPages = useMemo(() => new Set(hits.map((h) => h.page)), [hits]);

  const attachments = manifest.attachments.length ? (
    <ul aria-label="Attachments" className="flex flex-wrap gap-2">
      {manifest.attachments.map((a) => (
        <li key={a.document_id}>
          <Button variant="secondary" size="sm" onClick={() => onOpenAttachment?.(a)}>
            {a.name}
          </Button>
        </li>
      ))}
    </ul>
  ) : null;

  const renderPage = (pageNo: number) => {
    const layout = layouts.get(pageNo);
    const { marks } = marksFor(layout, target, hits);
    if (paged) {
      const size = manifest.pages[pageNo - 1];
      return (
        <PdfPage
          pdf={pdf}
          pageNo={pageNo}
          width={(size?.width ?? 612) * scale}
          height={(size?.height ?? 792) * scale}
          scale={scale}
          layout={layout}
          marks={marks}
        />
      );
    }
    if (!layout) return <Skeleton className="h-96 w-full" />;
    if (kind === "email") {
      return <EmailPage page={layout} marks={marks} attachments={attachments} />;
    }
    if (isTranscript(layout)) return <TranscriptPage page={layout} marks={marks} />;
    return <TextPage page={layout} marks={marks} ocr={layout.ocr} />;
  };

  const sheetLayout = layouts.get(sheetPage);

  const tools = (
    <>
      {anchors.length > 0 ? (
        <fieldset className="flex items-center gap-1" aria-label="Citations">
          <Tooltip content="Previous citation" shortcut="K">
            <Button
              variant="quiet"
              size="icon"
              aria-label="Previous citation"
              onClick={() => step(-1)}
            >
              <ChevronLeft aria-hidden />
            </Button>
          </Tooltip>
          <span className="tabular-nums">{`${index + 1} of ${anchors.length}`}</span>
          <Tooltip content="Next citation" shortcut="J">
            <Button variant="quiet" size="icon" aria-label="Next citation" onClick={() => step(1)}>
              <ChevronRight aria-hidden />
            </Button>
          </Tooltip>
        </fieldset>
      ) : null}
      <form
        className="flex items-center gap-1"
        onSubmit={(event) => {
          event.preventDefault();
          goTo(Number(pageInput.current?.value) || 1);
          scroller.current?.focus();
        }}
      >
        <label className="flex items-center gap-1 text-fg-muted">
          <span>{sheet ? "Sheet" : "Page"}</span>
          <input
            ref={pageInput}
            key={shownPage}
            defaultValue={shownPage}
            inputMode="numeric"
            aria-label={`Go to ${sheet ? "sheet" : "page"}, ${count} in all`}
            className="h-7 w-12 rounded-md border border-border bg-bg px-1 text-center text-fg tabular-nums"
          />
          <span className="tabular-nums">{`of ${count}`}</span>
        </label>
      </form>
      <search>
        <form
          className="flex items-center gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            if (hits.length) stepHit(1);
            else void runSearch();
          }}
        >
          <Search aria-hidden className="size-4 text-fg-muted" />
          <input
            ref={searchInput}
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setHits([]);
              setHitIndex(-1);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && event.shiftKey) {
                event.preventDefault();
                stepHit(-1);
              }
            }}
            placeholder="Search in document"
            aria-label="Search in document"
            className="h-7 w-44 rounded-md border border-border bg-bg px-2 text-fg"
          />
          <span className="min-w-16 text-caption text-fg-muted tabular-nums" aria-hidden>
            {searching ? "Searching…" : hits.length ? `${hitIndex + 1} of ${hits.length}` : ""}
          </span>
        </form>
      </search>
      {paged ? (
        <fieldset className="flex items-center" aria-label="Zoom">
          <Tooltip content="Zoom out" shortcut="-">
            <Button
              variant="quiet"
              size="icon"
              aria-label="Zoom out"
              onClick={() => setZoom(zoomOut(scale))}
            >
              <Minus aria-hidden />
            </Button>
          </Tooltip>
          <span className="w-12 text-center tabular-nums">{`${Math.round(scale * 100)}%`}</span>
          <Tooltip content="Zoom in" shortcut="+">
            <Button
              variant="quiet"
              size="icon"
              aria-label="Zoom in"
              onClick={() => setZoom(zoomIn(scale))}
            >
              <Plus aria-hidden />
            </Button>
          </Tooltip>
        </fieldset>
      ) : null}
      {sheet ? null : (
        <Tooltip content={strip ? "Hide pages" : "Show pages"} shortcut="T">
          <Button
            variant="quiet"
            size="icon"
            aria-label="Page list"
            aria-pressed={strip}
            onClick={() => setStrip((open) => !open)}
          >
            <PanelLeft aria-hidden />
          </Button>
        </Tooltip>
      )}
    </>
  );

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: shortcuts apply anywhere inside the viewer.
    <div className="h-full" onKeyDown={onKeyDown}>
      <ViewerFrame title={manifest.name} onClose={onClose} tools={tools}>
        {target?.status === "mismatch" || missed ? (
          <div role="note" className="border-b border-dashed border-flagged bg-bg px-4 py-2">
            <StatusText tone="flagged">
              {missed
                ? "This citation couldn't be found on the page."
                : "This citation didn't match the page exactly; the closest text is outlined."}
            </StatusText>
            {target?.quote ? <q className="ml-2 italic">{target.quote}</q> : null}
          </div>
        ) : null}
        {pdfFailed ? (
          <p role="note" className="border-b border-border bg-bg px-4 py-2 text-fg-muted">
            Text view, layout unavailable.
          </p>
        ) : null}
        {sheet ? (
          <SheetTabs manifest={manifest} layouts={layouts} page={sheetPage} onPage={setSheetPage} />
        ) : null}
        <div className="flex min-h-0 flex-1">
          {strip && !sheet ? (
            <PageStrip
              count={count}
              current={current}
              cited={citedPages}
              hits={hitPages}
              onPick={(page) => goTo(page)}
            />
          ) : null}
          <section
            ref={scroller}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: the pages scroll by keyboard.
            tabIndex={0}
            aria-label="Pages"
            className="relative min-h-0 flex-1 overflow-auto focus-visible:outline-2 focus-visible:outline-accent"
          >
            {sheet ? (
              <div className="p-4">
                {sheetLayout ? (
                  <SheetPage page={sheetLayout} marks={marksFor(sheetLayout, target, hits).marks} />
                ) : (
                  <Skeleton className="h-64 w-full" />
                )}
              </div>
            ) : (
              <div style={{ height: virtual.getTotalSize(), position: "relative" }}>
                {items.map((item) => (
                  <section
                    key={item.key}
                    data-index={item.index}
                    ref={paged ? undefined : virtual.measureElement}
                    aria-label={`Page ${item.index + 1}`}
                    className="absolute left-0 w-full"
                    style={{
                      transform: `translateY(${item.start}px)`,
                      ...(paged ? { height: item.size - GAP } : {}),
                    }}
                  >
                    {paged ? (
                      renderPage(item.index + 1)
                    ) : (
                      <div className="mx-auto mb-4 max-w-[720px] rounded-md border border-border bg-bg p-8 shadow-sm">
                        {renderPage(item.index + 1)}
                      </div>
                    )}
                  </section>
                ))}
              </div>
            )}
          </section>
        </div>
        {origin ? (
          <footer className="flex min-h-10 items-center gap-2 border-t border-border bg-bg px-4 text-fg-muted">
            <span>Where this came from:</span>
            {origin}
          </footer>
        ) : null}
        <p aria-live="polite" className="sr-only">
          {announce}
        </p>
      </ViewerFrame>
    </div>
  );
}

function PdfPage({
  pdf,
  pageNo,
  width,
  height,
  scale,
  layout,
  marks,
}: {
  pdf: PdfDocument | null;
  pageNo: number;
  width: number;
  height: number;
  scale: number;
  layout: PageLayout | undefined;
  marks: readonly Mark[];
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [painted, setPainted] = useState(false);
  useEffect(() => {
    const element = canvas.current;
    if (!pdf || !element) return;
    const controller = new AbortController();
    setPainted(false);
    pdf.renderPage(pageNo, element, scale, controller.signal).then(
      () => controller.signal.aborted || setPainted(true),
      () => {},
    );
    return () => controller.abort();
  }, [pdf, pageNo, scale]);
  return (
    <div
      className="relative mx-auto bg-white shadow-sm"
      style={{ width, height }}
      data-painted={painted || undefined}
    >
      <canvas ref={canvas} aria-hidden className="absolute inset-0 h-full w-full" />
      {painted ? null : <Skeleton className="absolute inset-0 rounded-none opacity-40" />}
      {layout
        ? marks.flatMap((mark) =>
            rectsFor(layout.lines, mark.from, mark.to).map((rect, i) => (
              <mark
                key={`${mark.kind}-${mark.from}-${rect.y}`}
                data-mark={mark.kind}
                aria-hidden={i === 0 ? undefined : true}
                className={cn(
                  "absolute rounded-xs text-transparent",
                  MARK_STYLES[mark.kind],
                  mark.kind === "cite" && "animate-pop-in",
                )}
                style={{
                  left: rect.x * scale,
                  top: rect.y * scale,
                  width: rect.width * scale,
                  height: rect.height * scale,
                }}
              >
                {i === 0 ? <span className="sr-only">{mark.label}</span> : null}
              </mark>
            )),
          )
        : null}
    </div>
  );
}

const STRIP_ITEM = 36;

function PageStrip({
  count,
  current,
  cited,
  hits,
  onPick,
}: {
  count: number;
  current: number;
  cited: ReadonlySet<number>;
  hits: ReadonlySet<number>;
  onPick: (page: number) => void;
}) {
  const parent = useRef<HTMLDivElement>(null);
  // Only the visible slice is in the DOM, however long the document.
  const strip = useVirtualizer({
    count,
    getScrollElement: () => parent.current,
    estimateSize: () => STRIP_ITEM,
    overscan: 4,
  });
  return (
    <nav aria-label="Page list" className="w-24 shrink-0 border-r border-border bg-bg">
      <div ref={parent} className="h-full overflow-auto">
        <ol style={{ height: strip.getTotalSize(), position: "relative" }}>
          {strip.getVirtualItems().map((item) => {
            const page = item.index + 1;
            const notes = [cited.has(page) && "cited", hits.has(page) && "search match"]
              .filter(Boolean)
              .join(", ");
            return (
              <li
                key={item.key}
                className="absolute left-0 w-full px-2"
                style={{ top: item.start, height: STRIP_ITEM }}
              >
                <button
                  type="button"
                  aria-current={page === current ? "page" : undefined}
                  aria-label={notes ? `Page ${page}, ${notes}` : `Page ${page}`}
                  onClick={() => onPick(page)}
                  className={cn(
                    "flex h-8 w-full items-center justify-between rounded-md px-2 tabular-nums hover:tint-hover focus-visible:outline-2 focus-visible:outline-accent",
                    page === current && "outline-2 outline-accent",
                  )}
                >
                  {page}
                  <span className="flex gap-0.5" aria-hidden>
                    {cited.has(page) ? <span className="size-2 rounded-full bg-citation" /> : null}
                    {hits.has(page) ? <span className="size-2 rounded-full bg-accent" /> : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </div>
    </nav>
  );
}

function SheetTabs({
  manifest,
  layouts,
  page,
  onPage,
}: {
  manifest: RenderManifest;
  layouts: ReadonlyMap<number, PageLayout>;
  page: number;
  onPage: (page: number) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Sheets"
      className="flex gap-1 overflow-x-auto border-b border-border bg-bg px-3"
    >
      {manifest.pages.map((p) => {
        const name = layouts.get(p.page_no)?.text.split("\n", 1)[0]?.trim() || `Sheet ${p.page_no}`;
        return (
          <button
            key={p.page_no}
            type="button"
            role="tab"
            aria-selected={p.page_no === page}
            onClick={() => onPage(p.page_no)}
            className={cn(
              "h-9 border-b-2 px-3 focus-visible:outline-2 focus-visible:outline-accent",
              p.page_no === page
                ? "border-accent font-semibold"
                : "border-transparent text-fg-muted",
            )}
          >
            {name}
          </button>
        );
      })}
    </div>
  );
}

import type { PageLayout, RenderManifest } from "@legallabs/contracts";
import { useVirtualizer } from "@tanstack/react-virtual";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "../cn.js";
import { Skeleton } from "../components/status.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/tabs.js";
import { rectsFor } from "./highlight.js";
import type { PdfDocument } from "./pdf.js";
import { MARK_STYLES, type Mark } from "./views.js";

export function PdfPage({
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

export function PageStrip({
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

/** Sheet tabs from the design system, with the chosen sheet as their one panel. */
export function SheetTabs({
  manifest,
  layouts,
  page,
  onPage,
  children,
}: {
  manifest: RenderManifest;
  layouts: ReadonlyMap<number, PageLayout>;
  page: number;
  onPage: (page: number) => void;
  children: ReactNode;
}) {
  return (
    <Tabs value={String(page)} onValueChange={(value) => onPage(Number(value))}>
      <TabsList aria-label="Sheets" className="sticky top-0 z-10 overflow-x-auto bg-bg px-4">
        {manifest.pages.map((p) => (
          <TabsTrigger key={p.page_no} value={String(p.page_no)}>
            {layouts.get(p.page_no)?.text.split("\n", 1)[0]?.trim() || `Sheet ${p.page_no}`}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value={String(page)} className="p-4">
        {children}
      </TabsContent>
    </Tabs>
  );
}

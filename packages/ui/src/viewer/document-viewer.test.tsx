// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DocumentViewer } from "../components/document-viewer.js";
import { fakePdf, fakeSource, LIABILITY, manifest, pdfPages } from "./fixtures.js";

afterEach(cleanup);

// jsdom has no layout, so the page area is given a size for the virtualiser to fill.
beforeAll(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 800,
    height: 900,
    top: 0,
    left: 0,
    right: 800,
    bottom: 900,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, value: 900 });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, value: 800 });
  // jsdom has no scrolling, so scroll position and height are kept by hand.
  const tops = new WeakMap<HTMLElement, number>();
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, value: 1e7 });
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get(this: HTMLElement) {
      return tops.get(this) ?? 0;
    },
    set(this: HTMLElement, value: number) {
      tops.set(this, value);
    },
  });
  HTMLElement.prototype.scrollTo = function scrollTo(
    this: HTMLElement,
    options?: ScrollToOptions | number,
  ) {
    this.scrollTop = typeof options === "number" ? options : (options?.top ?? 0);
    setTimeout(() => this.dispatchEvent(new Event("scroll")));
  } as HTMLElement["scrollTo"];
});

const pages = pdfPages(40);
const from = pages[13]?.text.indexOf(LIABILITY) ?? 0;
const anchor = {
  document_id: "01933b8a-7c2e-7d4a-9f10-3c5e8b2a1d4f",
  version_id: "01933b8a-7c2f-7a11-8b22-000000000001",
  page: 14,
  char_from: from,
  char_to: from + LIABILITY.length,
  quote: LIABILITY,
  status: "ok" as const,
};

function viewer(props: Partial<Parameters<typeof DocumentViewer>[0]> = {}) {
  return render(
    <div style={{ height: 900 }}>
      <DocumentViewer
        source={fakeSource(manifest("pdf", pages), pages)}
        loadPdf={fakePdf(pages)}
        target={anchor}
        {...props}
      />
    </div>,
  );
}

describe("DocumentViewer", () => {
  it("opens at the cited page and highlights the quote with an accessible name", async () => {
    viewer({ anchors: [anchor, { ...anchor, page: 3 }], onStep: vi.fn() });
    const mark = await screen.findByText(`Cited text: ${LIABILITY}`);
    expect(mark.closest("section[aria-label='Page 14']")).not.toBeNull();
    expect(screen.getByText("1 of 2")).toBeTruthy();
    expect(screen.getByText("Citation 1 of 2")).toBeTruthy();
  });

  it("steps through citations with j and k, wrapping at the ends", async () => {
    const onStep = vi.fn();
    viewer({ anchors: [anchor, { ...anchor, page: 3 }], onStep });
    await screen.findByText(`Cited text: ${LIABILITY}`);
    screen.getByRole("region", { name: "Pages" }).focus();
    await userEvent.keyboard("j");
    expect(onStep).toHaveBeenLastCalledWith(1);
    await userEvent.keyboard("k");
    expect(onStep).toHaveBeenLastCalledWith(1);
  });

  it("outlines an approximate match for a citation that didn't verify", async () => {
    viewer({
      target: {
        page: 14,
        status: "mismatch",
        quote: "The Supplier's aggregate liabilty under this agreement",
      },
    });
    expect(await screen.findByText(/didn't match the page exactly/)).toBeTruthy();
    await waitFor(() => expect(document.querySelector("[data-mark='approx']")).not.toBeNull());
  });

  it("says so when a quote can't be found, and shows the quote", async () => {
    viewer({
      target: { page: 14, status: "mismatch", quote: "Nothing like this is on the page at all." },
    });
    expect(await screen.findByText("This citation couldn't be found on the page.")).toBeTruthy();
    expect(screen.getByText("Nothing like this is on the page at all.")).toBeTruthy();
  });

  it("shows the same message for a walled document as a missing one", async () => {
    viewer({
      source: {
        ...fakeSource(manifest("pdf", pages), pages),
        manifest: () => Promise.reject(Object.assign(new Error("nope"), { status: 404 })),
      },
    });
    expect((await screen.findByRole("alert")).textContent).toContain(
      "wasn't found, or you don't have access",
    );
  });

  it("finds words in the document and counts the matches", async () => {
    viewer();
    await screen.findByText(`Cited text: ${LIABILITY}`);
    await userEvent.type(screen.getByLabelText("Search in document"), "9.2 Limitation{Enter}");
    expect(await screen.findByText("1 of 1")).toBeTruthy();
    expect(screen.getByText("1 match")).toBeTruthy();
  });

  it("outlines a cited cell and shows its formula", async () => {
    const text = "Fees\nA1: Total\nB1: =SUM(B2:B3) → 1500";
    const sheet = [{ page_no: 1, width: 0, height: 0, text, lines: [], ocr: false }];
    const at = text.indexOf("B1:");
    viewer({
      source: fakeSource(manifest("sheet", sheet), sheet),
      target: { page: 1, char_from: at, char_to: text.length },
    });
    const cell = await screen.findByRole("button", { name: "1500" });
    expect(cell.closest("td")?.dataset.mark).toBe("cite");
    expect(screen.getByText("=SUM(B2:B3)")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Fees" }).getAttribute("aria-selected")).toBe("true");
  });

  it("shows a loading state until the document arrives", () => {
    viewer({
      source: {
        ...fakeSource(manifest("pdf", pages), pages),
        manifest: () => new Promise(() => {}),
      },
    });
    expect(screen.getByText("Loading document…")).toBeTruthy();
  });
});

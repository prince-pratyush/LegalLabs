import { webSearchNotice } from "@legallabs/contracts";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { serve } from "../testing.js";
import { parseWebSearchRoute, webSearchRouteHash } from "./route.js";
import { WebSearchApp } from "./WebSearchApp.js";

const MATTER = "0190a000-0000-7000-8000-0000000000b1";
const settings = (over: object = {}) => ({
  configured: true,
  enabled: false,
  provider_host: "search.example",
  can_manage: true,
  blocked_matter_ids: [],
  ...over,
});
const routes = (view: object, extra = {}) => ({
  "GET /api/v1/web-search/settings": () => [200, view] as [number, unknown],
  "GET /api/v1/matters": () =>
    [200, { items: [{ id: MATTER, display: "Acme - 12" }] }] as [number, unknown],
  ...extra,
});
const show = () => render(<WebSearchApp onLeave={() => {}} />);

describe("web search administration", () => {
  it("has its own address", () => {
    expect(parseWebSearchRoute(webSearchRouteHash())).toBe(true);
    expect(parseWebSearchRoute("#/admin/models")).toBe(false);
  });

  it("starts off, says what would be sent, and turns on", async () => {
    let on = false;
    const sent = serve({
      ...routes(settings()),
      "GET /api/v1/web-search/settings": () => [200, settings({ enabled: on })],
      "PUT /api/v1/web-search/settings": () => {
        on = true;
        return [204, null];
      },
    });
    show();
    expect(await screen.findByText(webSearchNotice("search.example"))).toBeTruthy();
    expect(screen.getByText("Web search is off.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Turn on web search" }));
    expect(await screen.findByText("Web search is on.")).toBeTruthy();
    expect(sent.find((s) => s.route === "PUT /api/v1/web-search/settings")?.body).toEqual({
      enabled: true,
    });
  });

  it("keeps a matter from web search", async () => {
    const sent = serve(
      routes(settings({ enabled: true }), {
        [`PUT /api/v1/web-search/matters/${MATTER}`]: () => [204, null],
      }),
    );
    show();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Acme - 12" }));
    await waitFor(() =>
      expect(
        sent.find((s) => s.route === `PUT /api/v1/web-search/matters/${MATTER}`)?.body,
      ).toEqual({ blocked: true }),
    );
  });

  it("explains when no search service is set up", async () => {
    serve(routes(settings({ configured: false, provider_host: null })));
    show();
    expect(await screen.findByText(/No search service is set up/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Turn on web search" })).toBeNull();
  });

  it("shows nothing to change to someone who may not", async () => {
    serve(routes(settings({ can_manage: false })));
    show();
    expect(await screen.findByText("Web search is off.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Turn on web search" })).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});

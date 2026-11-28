// @vitest-environment node
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

const file = (name: string) => readFileSync(new URL(`../../public/${name}`, import.meta.url));

test("the manifest makes the app installable with icons of the stated size", () => {
  const manifest = JSON.parse(file("manifest.webmanifest").toString("utf8"));
  expect(manifest).toMatchObject({
    name: "LegalLabs",
    start_url: "/",
    scope: "/",
    display: "standalone",
  });
  const sizes = manifest.icons.map((i: { sizes: string }) => i.sizes);
  expect(sizes).toEqual(expect.arrayContaining(["192x192", "512x512"]));
  expect(manifest.icons.some((i: { purpose?: string }) => i.purpose === "maskable")).toBe(true);
  for (const icon of manifest.icons as { src: string; sizes: string }[]) {
    const png = file(icon.src.slice(1));
    expect(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`).toBe(icon.sizes);
  }
});

test("the offline page has nothing the content policy would block", () => {
  const html = file("offline.html").toString("utf8");
  expect(html).not.toMatch(/<script|<style|\sstyle=|\son\w+=/);
});

test("the page links the manifest and touch icon", () => {
  const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  expect(html).toContain('rel="manifest" href="/manifest.webmanifest"');
  expect(html).toContain('rel="apple-touch-icon" href="/apple-touch-icon.png"');
});

// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { formatKeys, matchesChord, useHotkeys } from "./shortcuts.js";

const press = (key: string, init: KeyboardEventInit = {}, target: EventTarget = window) =>
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));

describe("matchesChord", () => {
  it("treats Cmd and Ctrl alike", () => {
    const base = { key: "k", shiftKey: false, altKey: false };
    expect(matchesChord("mod+k", { ...base, metaKey: true, ctrlKey: false })).toBe(true);
    expect(matchesChord("mod+k", { ...base, metaKey: false, ctrlKey: true })).toBe(true);
    expect(matchesChord("mod+k", { ...base, metaKey: false, ctrlKey: false })).toBe(false);
  });

  it("needs shift only where the chord says so", () => {
    const o = { key: "o", metaKey: true, ctrlKey: false, altKey: false };
    expect(matchesChord("mod+shift+o", { ...o, shiftKey: true })).toBe(true);
    expect(matchesChord("mod+shift+o", { ...o, shiftKey: false })).toBe(false);
    const help = { key: "?", metaKey: false, ctrlKey: false, altKey: false, shiftKey: true };
    expect(matchesChord("?", help)).toBe(true);
  });
});

describe("formatKeys", () => {
  it("writes keys the way each platform does", () => {
    expect(formatKeys("mod+shift+o", true)).toBe("⌘⇧O");
    expect(formatKeys("mod+k", false)).toBe("Ctrl+K");
    expect(formatKeys("g t", true)).toBe("G then T");
  });
});

describe("useHotkeys", () => {
  it("runs a chord and a two-key sequence", () => {
    const palette = vi.fn();
    const threads = vi.fn();
    renderHook(() => useHotkeys({ "mod+k": palette, "g t": threads }));
    press("k", { metaKey: true });
    press("g");
    press("t");
    expect(palette).toHaveBeenCalledOnce();
    expect(threads).toHaveBeenCalledOnce();
  });

  it("leaves single letters alone while typing, but not chords", () => {
    const help = vi.fn();
    const palette = vi.fn();
    renderHook(() => useHotkeys({ "?": help, "mod+k": palette }));
    const field = document.body.appendChild(document.createElement("input"));
    press("?", { shiftKey: true }, field);
    press("k", { ctrlKey: true }, field);
    expect(help).not.toHaveBeenCalled();
    expect(palette).toHaveBeenCalledOnce();
    field.remove();
  });
});

describe("useHotkeys under a modal", () => {
  it("does nothing, so a second modal can't open on top", () => {
    const palette = vi.fn();
    renderHook(() => useHotkeys({ "mod+k": palette }));
    const modal = document.body.appendChild(document.createElement("div"));
    modal.setAttribute("aria-modal", "true");
    press("k", { metaKey: true });
    expect(palette).not.toHaveBeenCalled();
    modal.remove();
  });
});

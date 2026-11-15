import { describe, expect, it } from "vitest";
import {
  fillPrompt,
  LibraryGrant,
  PromptInput,
  promptVariables,
  TemplateChoice,
} from "./library.js";

describe("prompt variables", () => {
  it("finds each variable once, in order", () => {
    expect(
      promptVariables("Review {{ contract }} for {{party name}}; flag {{contract}} risks."),
    ).toEqual(["contract", "party name"]);
  });

  it("ignores braces that aren't variables", () => {
    expect(promptVariables("{{}} {{ }} {{-x}} {single} {{a\nb}}")).toEqual([]);
  });

  it("fills given values and leaves the rest for the user", () => {
    expect(
      fillPrompt("Draft for {{party}} by {{ date }}.", { party: "Acme Pty Ltd", date: " " }),
    ).toBe("Draft for Acme Pty Ltd by {{ date }}.");
  });

  it("does not read a value's own braces as another variable", () => {
    expect(fillPrompt("{{a}} {{b}}", { a: "{{b}}", b: "x" })).toBe("{{b}} x");
  });
});

describe("library schemas", () => {
  it("trims and bounds prompts", () => {
    expect(PromptInput.parse({ name: "  NDA review ", text: "Check {{x}}" }).name).toBe(
      "NDA review",
    );
    expect(PromptInput.safeParse({ name: "a", text: "x".repeat(8001) }).success).toBe(false);
    expect(PromptInput.safeParse({ name: " ", text: "x" }).success).toBe(false);
    expect(PromptInput.safeParse({ name: "a", text: "x\0" }).success).toBe(false);
  });

  it("accepts the three template choices and uuid v7 grants", () => {
    expect(TemplateChoice.safeParse("default").success).toBe(true);
    expect(TemplateChoice.safeParse("none").success).toBe(true);
    expect(TemplateChoice.safeParse("firm").success).toBe(false);
    const grant = {
      principal_type: "group",
      principal_id: "01936f7e-8a1b-7c3d-9e4f-0a1b2c3d4e5f",
      level: "use",
    };
    expect(LibraryGrant.safeParse(grant).success).toBe(true);
    expect(LibraryGrant.safeParse({ ...grant, level: "full" }).success).toBe(false);
  });
});

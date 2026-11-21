import { Dialog } from "radix-ui";
import { useState } from "react";
import { Button } from "../button.js";
import { Checkbox } from "../checkbox.js";

export interface ExportChoice {
  format: "xlsx" | "csv";
  highlight_verified: boolean;
  highlight_flagged: boolean;
  classify_colors: boolean;
  include_reasoning: boolean;
  include_citations: boolean;
}

const OPTIONS: { key: Exclude<keyof ExportChoice, "format">; label: string; excelOnly: boolean }[] =
  [
    { key: "highlight_verified", label: "Highlight verified cells", excelOnly: true },
    { key: "highlight_flagged", label: "Highlight flagged cells", excelOnly: true },
    { key: "classify_colors", label: "Colour list answers", excelOnly: true },
    { key: "include_reasoning", label: "Include the model's reasoning", excelOnly: false },
    { key: "include_citations", label: "Include citations as a sheet", excelOnly: true },
  ];

/** The one modal the table uses, since the browser owns the download (UX §5.9). */
export function ExportDialog({
  open,
  onOpenChange,
  onExport,
  filtered = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onExport: (choice: ExportChoice) => Promise<void>;
  /** When rows are filtered, the export says it only holds those rows. */
  filtered?: boolean;
}) {
  const [choice, setChoice] = useState<ExportChoice>({
    format: "xlsx",
    highlight_verified: true,
    highlight_flagged: true,
    classify_colors: true,
    include_reasoning: false,
    include_citations: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const excel = choice.format === "xlsx";

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      // CSV carries no formatting, so those options are dropped rather than ignored.
      await onExport(
        excel
          ? choice
          : {
              ...choice,
              highlight_verified: false,
              highlight_flagged: false,
              classify_colors: false,
              include_citations: false,
            },
      );
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't export. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-fg/40 data-[state=open]:animate-fade-in" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 grid w-[min(28rem,calc(100vw-2rem))] -translate-1/2 gap-3 rounded-lg border border-border bg-bg-raised p-6 text-fg shadow-xl data-[state=open]:animate-fade-in">
          <Dialog.Title className="text-section font-semibold">Export table</Dialog.Title>
          <Dialog.Description className="text-ui text-fg-muted">
            {filtered ? "Only the rows the filter shows are exported." : "Every row is exported."}
          </Dialog.Description>
          <fieldset className="flex gap-4">
            <legend className="mb-1 text-ui font-medium">Format</legend>
            {(
              [
                ["xlsx", "Excel"],
                ["csv", "CSV"],
              ] as const
            ).map(([format, name]) => (
              <label key={format} className="flex items-center gap-1">
                <input
                  type="radio"
                  name="format"
                  checked={choice.format === format}
                  onChange={() => setChoice((c) => ({ ...c, format }))}
                />
                {name}
              </label>
            ))}
          </fieldset>
          <fieldset className="grid gap-1">
            <legend className="mb-1 text-ui font-medium">Options</legend>
            {OPTIONS.map((option) => {
              const disabled = option.excelOnly && !excel;
              return (
                <span key={option.key} className="flex items-center gap-1">
                  <Checkbox
                    id={`export-${option.key}`}
                    disabled={disabled}
                    checked={!disabled && choice[option.key]}
                    onCheckedChange={(value) =>
                      setChoice((c) => ({ ...c, [option.key]: value === true }))
                    }
                  />
                  <label
                    htmlFor={`export-${option.key}`}
                    className={disabled ? "text-fg-muted" : ""}
                  >
                    {option.label}
                    {disabled && " (Excel only)"}
                  </label>
                </span>
              );
            })}
          </fieldset>
          {error && (
            <p role="alert" className="text-caption text-destructive">
              {error}
            </p>
          )}
          <div className="mt-2 flex justify-end gap-2">
            <Dialog.Close asChild>
              <Button variant="secondary">Cancel</Button>
            </Dialog.Close>
            <Button onClick={run} disabled={busy}>
              {busy ? "Preparing download…" : "Download"}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

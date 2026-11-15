import { Checkbox, Label } from "@legallabs/ui";
import { useId } from "react";
import { messageOf } from "../api.js";

// Re-exported, since the vault and library pages import it from here.
export { messageOf };

export const formatBytes = (bytes: number) => {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
};

export const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

export const ACCESS_LABEL = {
  owner: "Owner",
  full: "Full access",
  edit: "Can edit",
  view: "Can view",
};
export function CheckRow({
  checked,
  onChange,
  label,
  detail,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  detail?: string;
}) {
  const id = useId();
  return (
    <div className="flex items-start gap-2">
      <Checkbox id={id} checked={checked} onCheckedChange={(value) => onChange(value === true)} />
      <Label htmlFor={id} className="font-normal">
        {label}
        {detail && <span className="block text-caption text-fg-muted">{detail}</span>}
      </Label>
    </div>
  );
}

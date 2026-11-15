import { Checkbox, Label } from "@legallabs/ui";
import { useId } from "react";
import { ApiError } from "../api.js";

const FALLBACK = "Something went wrong. Try again.";
export const messageOf = (err: unknown) => (err instanceof ApiError ? err.message : FALLBACK);

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

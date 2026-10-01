"use client";

// Downloading the list you are looking at.
//
// THE RULE THIS COMPONENT EXISTS TO ENFORCE
//
// A download must contain exactly what is on screen, with the filters the
// person has set - not the whole table, and not the first page of it. That
// sounds obvious and it is the thing that goes wrong: somebody picks a date,
// presses download, and gets a file for every date, then sends it to the
// temple office who act on it.
//
// So this takes the SAME params object the screen passed to the list request.
// Not a copy of it, not a rebuilt one - the same value. If the screen's filter
// state changes, the download changes with it, because there is only one
// place the filters are described.
//
// WHY A MENU RATHER THAN TWO BUTTONS
// The office works in Excel and the people importing into other systems want
// CSV, and both are real. Two buttons in every page header is four words of
// chrome on twenty screens; one button with a choice is one.

import { useState } from "react";
import { Button, DropdownMenu, type ButtonSize, type ButtonVariant } from "./ui";
import { apiClient } from "@/lib/api";
import { istToday } from "@/lib/format";

/**
 * Pull the file down through the API client.
 *
 * It cannot be a plain <a href>: every export route sits behind the JWT, and
 * an anchor cannot carry an Authorization header. A link would hand the user a
 * 401 page named like a spreadsheet.
 */
async function download(path: string, filename: string): Promise<void> {
  const blob = await apiClient.getBlob(path);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked on the next tick rather than immediately: Safari has not always
  // finished reading the blob by the time click() returns, and revoking under
  // it produces a download that fails with no message.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ExportButton({
  /** The export endpoint WITHOUT an extension, e.g. "/crm/leads/export". */
  path,
  /** Exactly the params the list request used. */
  params,
  /** Used for the saved file's name: "leads" becomes leads-2026-10-01.xlsx. */
  filename,
  label = "Download",
  variant = "secondary",
  size = "md",
  disabled = false,
  /** Shown under each menu entry — e.g. how many rows will be in the file. */
  hint,
  className = "",
}: {
  path: string;
  params?: URLSearchParams | Record<string, string | number | boolean | undefined | null>;
  filename: string;
  label?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
  hint?: string;
  className?: string;
}) {
  const [busy, setBusy] = useState<"csv" | "xlsx" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const query = (): string => {
    if (!params) return "";
    const sp =
      params instanceof URLSearchParams
        ? new URLSearchParams(params)
        : new URLSearchParams(
            Object.entries(params)
              .filter(([, v]) => v !== undefined && v !== null && v !== "")
              .map(([k, v]) => [k, String(v)])
          );
    // The row cap belongs to the server, and page/limit describe the screen's
    // pagination - neither has any meaning in a file, and sending them would
    // produce a download of twenty-five rows out of four thousand.
    sp.delete("page");
    sp.delete("limit");
    const s = sp.toString();
    return s ? `?${s}` : "";
  };

  const run = async (format: "csv" | "xlsx") => {
    setBusy(format);
    setError(null);
    try {
      await download(`${path}.${format}${query()}`, `${filename}-${istToday()}.${format}`);
    } catch (e) {
      setError((e as Error).message || "The download failed");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={className}>
      <DropdownMenu
        items={[
          {
            label: "Excel (.xlsx)",
            icon: "sheet",
            hint: hint ?? "Opens cleanly, keeps phone numbers readable",
            onSelect: () => void run("xlsx"),
          },
          {
            label: "CSV (.csv)",
            icon: "fileText",
            hint: "For importing into another system",
            onSelect: () => void run("csv"),
          },
        ]}
        trigger={({ open, toggle }) => (
          <Button
            variant={variant}
            size={size}
            icon="download"
            iconRight="chevronDown"
            loading={busy !== null}
            disabled={disabled}
            onClick={toggle}
            aria-expanded={open}
            aria-haspopup="menu"
          >
            {label}
          </Button>
        )}
      />
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  );
}

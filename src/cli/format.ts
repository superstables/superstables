// Printing. The CLI's output is read by people who are about to spend money, so it follows
// two rules: one fact per line, and never a number without its unit. No colours, no spinners,
// no box drawing — this output is quoted into bug reports and pasted into terminals that do
// not speak ANSI.

import { untrustedText } from "../core/text.js";

// Nothing that came from somebody else reaches a terminal through `field` or `table` without `untrustedText`: an
// escape sequence in a listing name or a seller's answer could rewrite the owner's terminal title or redraw the
// client's own output.

/** A labelled fact: two columns, so a screenful of them lines up. */
export function field(label: string, value: string | number | undefined): string {
  return `  ${label.padEnd(16)}${value === undefined ? "—" : untrustedText(value, 400)}`;
}

/**
 * A plain text table. Columns are as wide as their widest cell, which keeps short tables
 * compact and long ones readable without wrapping logic that would lie about the width.
 */
export function table(headers: string[], rows: (string | number | undefined)[][]): string {
  // measured on the text as it will be printed, so a cell cannot change the shape of the table
  const cells = rows.map((row) => row.map((cell) => (cell === undefined ? "" : untrustedText(cell, 300))));
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...cells.map((row) => (row[index] ?? "").length)),
  );
  const line = (row: string[]) =>
    row
      .map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index])))
      .join("  ")
      .trimEnd();
  return [line(headers), line(widths.map((width) => "-".repeat(width))), ...cells.map(line)].join("\n");
}

export function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** "0.01 USDC", never "0.01" and never 0.009999999999999998. */
export function money(amountDecimal: number, asset: string): string {
  return `${Number(amountDecimal.toFixed(6))} ${asset}`;
}

export function yesNo(value: boolean | undefined): string {
  return value === undefined ? "unknown" : value ? "yes" : "no";
}

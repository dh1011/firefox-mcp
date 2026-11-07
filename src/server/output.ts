/** Output limits, and errors written for the model */

export const READ_CAP = 10_000;
/** A little under the response's cap, so one such read fits whole with its status lines */
export const READ_CAP_MAX = 75_000;
/** MCP clients refuse very large results. Snapshots run about 3 characters per token */
export const RESPONSE_CAP = 80_000;
export const MAX_IMAGES = 3;

/** An error whose message is meant for the model as is */
export class StepError extends Error {}

export function readCap(flag: string | true | undefined): number {
  if (flag === undefined || flag === true) return READ_CAP;
  if (flag === "all") return READ_CAP_MAX;
  const value = Number(flag);
  if (!Number.isInteger(value) || value <= 0) {
    throw new StepError("--max takes a number of characters or all, e.g. --max 2000");
  }
  return Math.min(value, READ_CAP_MAX);
}

/** Cuts text at a line break near `max`, and says how to read all of it or narrow it */
export function cap(
  text: string,
  max: number,
  hint = 'narrow it with `find "<text>"`, a target (`snapshot <target>`), `--depth N` or `-i`',
): string {
  if (text.length <= max) return text;
  let cut = text.lastIndexOf("\n", max);
  if (cut < max * 0.8) cut = max;
  const all =
    max >= READ_CAP_MAX
      ? ""
      : text.length <= READ_CAP_MAX
        ? "--max all reads all of it, or "
        : `--max all reads the first ${READ_CAP_MAX}, or `;
  return `${text.slice(0, cut)}\n… cut at ${cut} of ${text.length} characters: ${all}${hint}`;
}

/** Keeps the end of a log, where the newest entries are */
export function capTail(text: string, max: number): string {
  if (text.length <= max) return text;
  let start = text.indexOf("\n", text.length - max);
  if (start < 0) start = text.length - max;
  return `… ${start} earlier characters cut; add --filter or raise --max\n${text.slice(start + 1)}`;
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

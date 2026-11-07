/** Set by the build: `0.1.0+<hash of the sources>`, so a rebuilt server replaces a daemon still running older code */
declare const __VERSION__: string;

export const VERSION: string = typeof __VERSION__ === "string" ? __VERSION__ : "0.0.0-dev";

/** Compares the numeric part of two versions */
export function compareVersions(a: string, b: string): number {
  const parts = (version: string) => (version.split("+")[0] ?? "").split(/[.-]/).map((part) => Number(part) || 0);
  const [left, right] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

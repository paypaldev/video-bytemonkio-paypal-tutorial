/**
 * Console narration.
 *
 * These scenarios are meant to be READ ON SCREEN while someone talks over
 * them. That constraint drives every choice here: wide labels, one idea per
 * line, and the interesting value always at the end of the line where the eye
 * lands. Raw JSON is available but opt-in (VERBOSE=1), because a wall of JSON
 * is unreadable at 1080p.
 */

const useColor = process.env.NO_COLOR === undefined && process.stdout.isTTY !== false;

const wrap = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

export const c = {
  bold: wrap("1"),
  dim: wrap("2"),
  red: wrap("31"),
  green: wrap("32"),
  yellow: wrap("33"),
  blue: wrap("34"),
  magenta: wrap("35"),
  cyan: wrap("36"),
  grey: wrap("90"),
};

const WIDTH = 74;

/** A scenario title card. First thing on screen for every demo. */
export function title(name: string, subtitle?: string): void {
  const bar = "─".repeat(WIDTH);
  console.log("");
  console.log(c.cyan(`┌${bar}┐`));
  console.log(c.cyan("│ ") + c.bold(name.padEnd(WIDTH - 2)) + c.cyan(" │"));
  if (subtitle) {
    console.log(c.cyan("│ ") + c.grey(subtitle.padEnd(WIDTH - 2)) + c.cyan(" │"));
  }
  console.log(c.cyan(`└${bar}┘`));
}

/** A numbered beat within a scenario. */
export function step(n: number | string, text: string): void {
  const marker = typeof n === "number" ? `${n}.` : n;
  console.log("");
  console.log(c.bold(c.blue(`  ${marker} ${text}`)));
}

/** A key/value fact. The value is what the camera should catch. */
export function fact(label: string, value: string | number | undefined | null): void {
  const v = value === undefined || value === null ? c.grey("(none)") : String(value);
  console.log(`     ${c.grey(label.padEnd(26, "."))} ${c.bold(v)}`);
}

/** Something the integration got right. */
export function ok(text: string): void {
  console.log(`     ${c.green("✔")} ${text}`);
}

/** Something that failed — expected or not. Never thrown away silently. */
export function bad(text: string): void {
  console.log(`     ${c.red("✘")} ${text}`);
}

/** A decision the APPLICATION made, as opposed to something PayPal did. */
export function decision(text: string): void {
  console.log(`     ${c.magenta("◆")} ${c.magenta("app decides:")} ${text}`);
}

/** Something PayPal did, as opposed to something the application decided. */
export function paypal(text: string): void {
  console.log(`     ${c.blue("◆")} ${c.blue("PayPal:")} ${text}`);
}

export function note(text: string): void {
  console.log(`     ${c.grey("│")} ${c.grey(text)}`);
}

export function warn(text: string): void {
  console.log(`     ${c.yellow("!")} ${c.yellow(text)}`);
}

export function blank(): void {
  console.log("");
}

/** A closing takeaway line — the sentence the video repeats out loud. */
export function takeaway(text: string): void {
  console.log("");
  console.log(c.cyan("  ▸ ") + c.bold(text));
  console.log("");
}

/** Full JSON, only when asked for. Keeps the default output narratable. */
export function verbose(label: string, value: unknown): void {
  if (process.env.VERBOSE !== "1") return;
  console.log(c.grey(`     --- ${label} ---`));
  console.log(
    c.grey(
      JSON.stringify(value, null, 2)
        .split("\n")
        .map((l) => `     ${l}`)
        .join("\n"),
    ),
  );
}

/** An HTTP exchange, rendered compactly. */
export function http(method: string, url: string, status?: number): void {
  const path = url.replace(/^https?:\/\/[^/]+/, "");
  const statusText =
    status === undefined
      ? ""
      : status < 300
        ? c.green(` → ${status}`)
        : status < 500
          ? c.yellow(` → ${status}`)
          : c.red(` → ${status}`);
  console.log(`     ${c.grey(`${method.toUpperCase()} ${path}`)}${statusText}`);
}

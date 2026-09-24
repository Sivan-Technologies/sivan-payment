/**
 * Console formatting for the demo runner.
 *
 * The output is the deliverable here: these scripts exist to be watched in an
 * unedited screen recording, so alignment and restraint matter more than
 * decoration. Colour is disabled automatically when the output is piped, so
 * logs stay readable in a file.
 */

const TTY = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const c = (code) => (s) => (TTY ? `\x1b[${code}m${s}\x1b[0m` : String(s));

export const dim = c("2;37");
export const bold = c("1");
export const green = c("32");
export const blue = c("36");
export const yellow = c("33");
export const red = c("31");
export const grey = c("90");

let stepNo = 0;

export function banner(title, subtitle) {
  const line = "─".repeat(66);
  console.log("\n" + grey(line));
  console.log(bold(title));
  if (subtitle) console.log(grey(subtitle));
  console.log(grey(line));
}

export function step(title) {
  stepNo += 1;
  console.log(`\n${bold(blue(`${stepNo}.`))} ${bold(title)}`);
}

export function field(label, value) {
  console.log(`   ${grey(label.padEnd(22))} ${value}`);
}

export function ok(msg) {
  console.log(`   ${green("OK")}   ${msg}`);
}

export function warn(msg) {
  console.log(`   ${yellow("WARN")} ${msg}`);
}

export function fail(msg) {
  console.log(`   ${red("FAIL")} ${msg}`);
}

export function note(msg) {
  console.log(`   ${grey(msg)}`);
}

/**
 * Print a value that is simulated rather than observed.
 *
 * Kept visually distinct because the alternative, a mock that looks identical
 * to a real result, is how a demo quietly starts asserting things that never
 * happened.
 */
export function simulated(label, value) {
  console.log(`   ${grey(label.padEnd(22))} ${value} ${yellow("[simulated]")}`);
}

export function resetSteps() {
  stepNo = 0;
}

// `npm run check`: runs the named npm scripts one after another and keeps going after a failure, so one run
// shows every failing step. It prints a line per step with its time, then the tail of each failure, and keeps
// the whole output in node_modules/.cache/check/last.log: read that log instead of running the gate again.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { constants } from "node:os";

const LOG = "node_modules/.cache/check/last.log";
const TAIL_LINES = 40;
const posix = process.platform !== "win32";

const steps = process.argv.slice(2);
const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts ?? {};
const unknown = steps.filter((step) => !Object.hasOwn(scripts, step));
if (steps.length === 0 || unknown.length > 0) {
  console.error(`check: no npm script named ${unknown.join(", ") || "(none given)"}`);
  process.exit(2);
}

mkdirSync("node_modules/.cache/check", { recursive: true });
writeFileSync(LOG, "");
console.log(`check: ${steps.join(", ")}. Full output: ${LOG}`);

let running;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    // Each step runs in its own process group, so a timeout or Ctrl-C must stop it here or it outlives the gate.
    if (running) stop(running, signal);
    process.exit(128 + constants.signals[signal]);
  });
}

const results = [];
for (const step of steps) {
  appendFileSync(LOG, `\n===== npm run ${step}\n`);
  const started = performance.now();
  const { code, output } = await run(step);
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.log(`${code === 0 ? "ok  " : "FAIL"} ${step} (${seconds} s)`);
  results.push({ step, code, output });
}

const failed = results.filter((result) => result.code !== 0);
for (const { step, code, output } of failed) {
  console.log(`\n--- ${step} failed with exit ${code}. Its last lines:`);
  console.log(output.trimEnd().split("\n").slice(-TAIL_LINES).join("\n"));
}
console.log(
  failed.length === 0 ? "\ncheck passed" : `\ncheck failed: ${failed.map((result) => result.step).join(", ")}`,
);
process.exit(failed.length === 0 ? 0 : 1);

/** Runs one npm script with its output captured into the log, and resolves with its exit code and output. */
function run(step) {
  return new Promise((resolve) => {
    const child = spawn("npm", ["run", step], { detached: posix, shell: !posix });
    running = child;
    const chunks = [];
    const keep = (data) => {
      chunks.push(data);
      appendFileSync(LOG, data);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("error", (error) => keep(Buffer.from(`${error.message}\n`)));
    child.on("close", (code) => {
      running = undefined;
      resolve({ code: code ?? 1, output: Buffer.concat(chunks).toString() });
    });
  });
}

/** Sends the signal to the step's whole process group (npm, its shell and the tool), not only to npm. */
function stop(child, signal) {
  try {
    if (posix) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // The step had already exited.
  }
}

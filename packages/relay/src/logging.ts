// The relay's log file — `~/.lumi-relay/logs/relay.log`, rotated at 5 MB keeping 3 generations.
//
// Ported nearly verbatim from `packages/crew/runner/src/logging.ts` in the Lumi repo, and the
// reason it exists is the same: once the process is a systemd unit nobody is watching stdout, and
// `journalctl --user` is not available on every box this might end up on. `lumi-relay logs -f`
// reads this file.
//
// Writes are best-effort and NEVER throw. A full disk must not be what takes a relay down while
// somebody's agent is halfway through a click.

import fs from "node:fs";
import path from "node:path";
import { logDir } from "./paths.js";

const MAX_BYTES = 5 * 1024 * 1024;
const KEEP = 3;

export function logFile(): string {
  return path.join(logDir(), "relay.log");
}

/**
 * Bytes in the live file, tracked in memory so a rotation check costs no syscall per line.
 * `null` = not yet known; one process owns the file, so drift is not the concern it would be with
 * concurrent writers.
 */
let liveBytes: number | null = null;

function rotate(): void {
  const base = logFile();
  try {
    fs.rmSync(`${base}.${KEEP}`, { force: true });
    for (let i = KEEP - 1; i >= 1; i--) {
      if (fs.existsSync(`${base}.${i}`)) fs.renameSync(`${base}.${i}`, `${base}.${i + 1}`);
    }
    if (fs.existsSync(base)) fs.renameSync(base, `${base}.1`);
  } catch {
    // Rotation is housekeeping; failing it must not lose the line we are about to write.
  }
  liveBytes = 0;
}

/** Append one line (a trailing newline is added). Best-effort. */
export function appendLog(line: string): void {
  const file = logFile();
  const payload = `${line}\n`;
  try {
    if (liveBytes === null) {
      fs.mkdirSync(logDir(), { recursive: true, mode: 0o700 });
      liveBytes = fs.existsSync(file) ? fs.statSync(file).size : 0;
    }
    if (liveBytes + payload.length > MAX_BYTES) rotate();
    fs.appendFileSync(file, payload);
    liveBytes += payload.length;
  } catch {
    // Swallow: logging must never be the reason the relay dies.
  }
}

/**
 * The last `count` lines, oldest first. Reads the previous generation too when the live file is
 * short — right after a rotation it would otherwise look like the history vanished.
 */
export function readTail(count: number): string[] {
  const base = logFile();
  const chunks: string[] = [];
  for (const file of [`${base}.1`, base]) {
    try {
      chunks.push(fs.readFileSync(file, "utf8"));
    } catch {
      // Missing generation — nothing to add.
    }
  }
  return chunks
    .join("")
    .split("\n")
    .filter((l) => l.length > 0)
    .slice(-count);
}

/**
 * Follow the live file, invoking `onLine` for each new line. Returns a stop function.
 *
 * Polls rather than using fs.watch: watch semantics differ across platforms and break on the
 * rename a rotation performs, while a 500 ms poll is portable and cheap. A file that SHRANK was
 * rotated — reopen from zero so the tail continues into the new generation.
 */
export function followLog(onLine: (line: string) => void, intervalMs = 500): () => void {
  const file = logFile();
  let position = 0;
  try {
    position = fs.statSync(file).size;
  } catch {
    position = 0;
  }

  const tick = (): void => {
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      return; // not created yet
    }
    if (size < position) position = 0; // rotated
    if (size === position) return;
    try {
      const fd = fs.openSync(file, "r");
      const buffer = Buffer.alloc(size - position);
      fs.readSync(fd, buffer, 0, buffer.length, position);
      fs.closeSync(fd);
      position = size;
      for (const line of buffer.toString("utf8").split("\n")) {
        if (line.length > 0) onLine(line);
      }
    } catch {
      // Transient read error — the next tick picks up from the same position.
    }
  };

  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";

/** Diretorio temporario apagado ao fim do arquivo de teste. */
export function tempDir(prefix = "isbackup-test-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function fileMode(file: string): number {
  return fs.statSync(file).mode & 0o777;
}

/** Silencia console.log/error durante fn (os loggers escrevem no console tambem). */
export async function quietly<T>(fn: () => T | Promise<T>): Promise<T> {
  const { log, error, warn } = console;
  console.log = console.error = console.warn = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, { log, error, warn });
  }
}

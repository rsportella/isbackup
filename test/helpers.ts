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

export const isWindows = process.platform === "win32";

/**
 * Confere as permissoes Unix de um arquivo. No Windows nao existe esse modelo (chmod so liga/desliga
 * "somente leitura"), entao a checagem e pulada — o resto do teste continua valendo.
 */
export function assertMode(file: string, expected: number): void {
  if (isWindows) return;
  const actual = fileMode(file);
  if (actual !== expected) {
    throw new Error(`permissao de ${file}: esperado ${expected.toString(8)}, veio ${actual.toString(8)}`);
  }
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

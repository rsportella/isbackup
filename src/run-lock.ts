import fs from "node:fs";
import path from "node:path";
import type { JobConfig } from "./types.js";

export interface RunProgress {
  bytesDone: number;
  bytesTotal: number;
  filesDone: number;
  filesTotal: number;
}

export type RunPhase = "downloading" | "compressing";

export interface RunLock {
  pid: number;
  startedAt: string;
  /** So preenchido por jobs do tipo "files" (sabe o tamanho total antes de baixar). Jobs de
   * banco nao tem como estimar um total, entao ficam sem — a UI cai pro tempo decorrido nesse
   * caso. */
  progress?: RunProgress;
  /** So relevante pra job de arquivos: depois que os downloads terminam (progress bate 100%),
   * ainda falta compactar em .tar.gz — sem isso a UI mostrava "100%" parado, sem indicar que
   * ainda tem coisa acontecendo (a compactacao de um volume grande pode levar um tempo real). */
  phase?: RunPhase;
}

// O cron dispara "node dist/cli.js run <job>" como um processo separado do servidor da UI, entao
// o estado "rodando" nao pode viver so em memoria (o processo da UI nunca saberia). Um arquivo de
// lock no proprio outputDir do job resolve isso: qualquer processo (CLI ou UI) consegue ler.
// Compartilhado pelos dois tipos de job (banco e arquivos) — so depende de name/outputDir,
// comuns aos dois.
function lockFilePath(job: JobConfig): string {
  return path.join(job.outputDir, `.${job.name}.running.json`);
}

function cancelFilePath(job: JobConfig): string {
  return path.join(job.outputDir, `.${job.name}.cancel-requested`);
}

/** Sinaliza que o run atual do job deve ser interrompido. Mesmo truque do lock: um arquivo no
 * outputDir, pra funcionar cross-process (o "Parar" clicado na UI pode ter que interromper um
 * run que na verdade esta rodando dentro de um "isbackup run" disparado pelo cron, um processo
 * totalmente separado do servidor da UI). Quem esta rodando o job checa esse arquivo
 * periodicamente (a cada callback de progresso, ou por um intervalo) em vez de depender de sinal
 * de SO — mais simples e cross-plataforma. */
export function requestCancel(job: JobConfig): void {
  fs.writeFileSync(cancelFilePath(job), String(Date.now()));
}

export function isCancelRequested(job: JobConfig): boolean {
  return fs.existsSync(cancelFilePath(job));
}

export function clearCancelRequest(job: JobConfig): void {
  fs.rmSync(cancelFilePath(job), { force: true });
}

/** Erro usado pra sinalizar que o job foi interrompido a pedido do usuario, distinto de uma
 * falha de verdade — quem trata o erro (runBackup/runFileBackup e seus chamadores) usa isso pra
 * marcar o job como "Cancelado" em vez de "Falhou". */
export class RunCancelledError extends Error {
  constructor() {
    super("Cancelado pelo usuario.");
    this.name = "RunCancelledError";
  }
}

export function writeRunLock(job: JobConfig): void {
  // Remove qualquer pedido de cancelamento deixado por um run anterior — senao um "Parar" de uma
  // execucao passada cancelaria essa nova instantaneamente.
  clearCancelRequest(job);
  const lock: RunLock = { pid: process.pid, startedAt: new Date().toISOString() };
  fs.writeFileSync(lockFilePath(job), JSON.stringify(lock));
}

export function clearRunLock(job: JobConfig): void {
  fs.rmSync(lockFilePath(job), { force: true });
}

/** Atualiza o progresso de um run ja em andamento (mantendo pid/startedAt do lock existente).
 * Chamado com throttling por quem baixa os arquivos — nao precisa ser exato a cada byte, so
 * dar uma nocao real de "esta andando" (e nao travado) pra UI. */
export function updateRunProgress(job: JobConfig, progress: RunProgress): void {
  try {
    const raw = fs.readFileSync(lockFilePath(job), "utf8");
    const lock = JSON.parse(raw) as RunLock;
    lock.progress = progress;
    fs.writeFileSync(lockFilePath(job), JSON.stringify(lock));
  } catch {
    // o lock pode ter sido removido entre uma atualizacao e outra (run ja terminou) — ignora
  }
}

/** Marca a fase atual de um run ja em andamento (mantendo o resto do lock). */
export function updateRunPhase(job: JobConfig, phase: RunPhase): void {
  try {
    const raw = fs.readFileSync(lockFilePath(job), "utf8");
    const lock = JSON.parse(raw) as RunLock;
    lock.phase = phase;
    fs.writeFileSync(lockFilePath(job), JSON.stringify(lock));
  } catch {
    // idem — lock pode ter sido removido entre uma atualizacao e outra
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Le o lock de execucao de um job (cross-process). Ignora locks orfaos — de um processo que
 * morreu sem limpar o proprio lock (kill -9, queda de energia, etc) — checando se o pid ainda
 * esta vivo, pra nao deixar o card preso em "Rodando" pra sempre nesse caso.
 */
export function readRunLock(job: JobConfig): RunLock | null {
  try {
    const raw = fs.readFileSync(lockFilePath(job), "utf8");
    const lock = JSON.parse(raw) as RunLock;
    if (typeof lock.pid !== "number" || !isPidAlive(lock.pid)) return null;
    return lock;
  } catch {
    return null;
  }
}

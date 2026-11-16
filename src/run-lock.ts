import fs from "node:fs";
import path from "node:path";
import type { JobConfig } from "./types.js";
import type { JobLogger } from "./job-log.js";

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

/** O job ja esta rodando em outro processo (ou neste) — o novo run nao comeca. */
export class RunAlreadyActiveError extends Error {
  constructor(jobName: string, pid: number) {
    super(`Job "${jobName}" ja esta rodando (pid ${pid}); esta execucao foi ignorada.`);
    this.name = "RunAlreadyActiveError";
  }
}

/**
 * Adquire o lock de execucao do job, de forma exclusiva: o arquivo e criado com a flag "wx",
 * que falha se ele ja existir — atomico no filesystem. Antes, quem chamava checava readRunLock()
 * e depois escrevia o lock: dois processos (ex: o cron e o self-heal da UI no mesmo minuto)
 * podiam passar os dois pela checagem e rodar o mesmo dump em paralelo, um sobrescrevendo o
 * lock/arquivo do outro.
 *
 * Um lock orfao (pid morto: kill -9, queda de energia) e descartado e a aquisicao e refeita.
 * Lanca RunAlreadyActiveError se outro run vivo segura o lock — nesse caso nada foi alterado,
 * entao quem chamou nao deve limpar o lock/cancelamento (eles pertencem ao outro run).
 */
export function writeRunLock(job: JobConfig): void {
  const lock: RunLock = { pid: process.pid, startedAt: new Date().toISOString() };
  const file = lockFilePath(job);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify(lock), { flag: "wx" });
      // So depois de garantir o lock: remove qualquer pedido de cancelamento deixado por um run
      // anterior — senao um "Parar" de uma execucao passada cancelaria essa nova na hora.
      clearCancelRequest(job);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const holder = readRunLock(job);
      if (holder) throw new RunAlreadyActiveError(job.name, holder.pid);
      // Lock ilegivel mas recem-criado: o outro processo pode estar no meio da escrita (o arquivo
      // ja existe, o JSON ainda nao). Nao e orfao — nao apaga.
      if (isFreshFile(file)) throw new RunAlreadyActiveError(job.name, -1);
      fs.rmSync(file, { force: true }); // lock orfao (pid morto) — descarta e tenta de novo
    }
  }
  throw new RunAlreadyActiveError(job.name, -1);
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

/** writeRunLock + registro no log do job quando o run e ignorado (outro ja esta rodando). */
export function acquireRunLock(job: JobConfig, jobLog: JobLogger): void {
  try {
    writeRunLock(job);
  } catch (err) {
    if (err instanceof RunAlreadyActiveError) jobLog.info(err.message);
    else jobLog.error(`Job "${job.name}": nao foi possivel criar o lock de execucao: ${(err as Error).message}`);
    throw err;
  }
}

function isFreshFile(file: string, maxAgeMs = 5000): boolean {
  try {
    const raw = fs.readFileSync(file, "utf8");
    JSON.parse(raw);
    return false; // legivel: readRunLock ja decidiu (pid morto = orfao)
  } catch {
    try {
      return Date.now() - fs.statSync(file).mtimeMs < maxAgeMs;
    } catch {
      return false;
    }
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

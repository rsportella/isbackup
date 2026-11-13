import { loadConfig } from "../config.js";
import { readRunLock } from "../run-lock.js";
import { resolveSchedule } from "../cron.js";
import { computeScheduleStatus } from "../schedule-status.js";
import { listBackupFiles } from "../backups.js";
import { logger } from "../logger.js";
import type { JobConfig } from "../types.js";
import { triggerJobRun } from "./run-trigger.js";

export interface CatchUpOptions {
  configPath: string;
  logDir: string;
  /** Intervalo entre checagens, em ms. */
  checkIntervalMs?: number;
  /** Tempo minimo entre tentativas de catch-up pro mesmo job, pra nao ficar tentando de novo a
   * cada checagem enquanto algo continuar falhando (ex: rede fora, credencial errada). */
  cooldownMs?: number;
}

const DEFAULT_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 min
const DEFAULT_COOLDOWN_MS = 15 * 60 * 1000; // 15 min

/**
 * Rede de seguranca contra o cron simplesmente pular um horario porque a maquina estava
 * dormindo — o cron do macOS nao roda durante o sono e, diferente do launchd, nao recupera o
 * horario perdido depois (ver README). Enquanto o servidor da UI estiver de pe (inclusive assim
 * que ele volta a rodar apos a maquina acordar), essa checagem periodica olha se algum job ativo
 * esta atrasado segundo o proprio schedule — e, se estiver (e ninguem ja estiver rodando ele),
 * dispara o backup na hora, preenchendo o buraco.
 *
 * Isso so cobre a janela em que "isbackup ui" esta rodando; nao substitui o cron (que continua
 * cuidando do horario normal) nem ajuda se o processo da UI tambem nao estiver de pe.
 */
export function startCatchUpScheduler(opts: CatchUpOptions): NodeJS.Timeout {
  const checkIntervalMs = opts.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
  const cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const lastAttempt = new Map<string, number>();

  function check(): void {
    let jobs: JobConfig[];
    try {
      jobs = loadConfig(opts.configPath).filter((j) => !j.paused);
    } catch (err) {
      logger.error(`Self-heal: nao foi possivel ler config.yaml (${(err as Error).message}).`);
      return;
    }

    for (const job of jobs) {
      let resolvedSchedule: string;
      try {
        resolvedSchedule = resolveSchedule(job.schedule);
      } catch {
        continue; // schedule invalido — deixa o resto da UI acusar isso, nao e papel do self-heal
      }

      const last = listBackupFiles(job)[0];
      const status = computeScheduleStatus(resolvedSchedule, last ? last.mtimeMs : null);
      if (status.health !== "overdue") continue;
      if (readRunLock(job)) continue; // ja rodando (cron ou UI) — nada a fazer

      const now = Date.now();
      const attemptedAt = lastAttempt.get(job.name);
      if (attemptedAt !== undefined && now - attemptedAt < cooldownMs) continue;

      lastAttempt.set(job.name, now);
      triggerJobRun(job, opts.logDir, {
        reason: "self-heal: horario agendado parece ter sido perdido (cron nao roda com a maquina dormindo)",
      });
    }
  }

  // Roda uma checagem logo de cara tambem — cobre o caso comum de abrir o Mac de manha com o
  // "isbackup ui" configurado pra subir junto, sem esperar o primeiro intervalo completo.
  check();
  return setInterval(check, checkIntervalMs);
}

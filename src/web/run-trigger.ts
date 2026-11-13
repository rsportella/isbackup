import { runJobBackup } from "../backup-runner.js";
import { RunCancelledError } from "../run-lock.js";
import { createJobLogger } from "../job-log.js";
import type { JobConfig } from "../types.js";
import { setJobState } from "./state.js";

/**
 * Dispara um backup em background e atualiza o estado em memoria (usado pela UI pra mostrar
 * sucesso/erro do run mais recente). Nao bloqueia — quem chama decide o que fazer enquanto roda
 * (a rota HTTP responde 202 na hora; o self-heal so loga). Compartilhado entre a rota
 * POST /jobs/:name/run e o self-heal (catchup.ts) pra nao duplicar a logica de atualizar estado.
 */
export function triggerJobRun(job: JobConfig, logDir: string, options: { reason?: string } = {}): string {
  const startedAt = new Date().toISOString();
  setJobState(job.name, { status: "running", startedAt });
  if (options.reason) {
    createJobLogger(logDir, job.name).info(`Disparando backup (${options.reason}).`);
  }

  runJobBackup(job, { logDir })
    .then((outputFile) => {
      setJobState(job.name, {
        status: "success",
        startedAt,
        finishedAt: new Date().toISOString(),
        outputFile: outputFile ?? undefined,
      });
    })
    .catch((err: Error) => {
      // O detalhe do erro ja foi gravado em logs/<job>.log dentro de runBackup/runFileBackup
      // (mensagem mais especifica, com o "Falhou:"); aqui so atualiza o estado pra UI.
      setJobState(job.name, {
        status: err instanceof RunCancelledError ? "cancelled" : "error",
        startedAt,
        finishedAt: new Date().toISOString(),
        message: err.message,
      });
    });

  return startedAt;
}

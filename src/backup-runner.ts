import type { JobConfig } from "./types.js";
import { runBackup, type RunBackupOptions } from "./dump.js";
import { runFileBackup } from "./file-backup.js";

/**
 * Executa o backup de um job, despachando pro dump de banco (mysqldump) ou pro backup de
 * arquivos (SFTP/FTP) conforme job.type. Ponto unico de entrada — usado tanto pelo comando "run"
 * do CLI (o que o cron de fato dispara) quanto pelo triggerJobRun da UI (usado por "Executar
 * agora" e pelo self-heal) — pra garantir que os dois tipos de job funcionem em todos os
 * caminhos de execucao sem duplicar essa decisao em varios lugares.
 */
export function runJobBackup(job: JobConfig, options: RunBackupOptions): Promise<string | null> {
  return job.type === "files" ? runFileBackup(job, options) : runBackup(job, options);
}

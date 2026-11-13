import fs from "node:fs";
import path from "node:path";
import type { JobConfig } from "./types.js";
import type { JobLogger } from "./job-log.js";

export interface BackupFile {
  filename: string;
  path: string;
  size: number;
  mtimeMs: number;
}

/** Lista os arquivos de backup de um job, mais recentes primeiro. */
export function listBackupFiles(job: JobConfig): BackupFile[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(job.outputDir);
  } catch {
    return [];
  }

  const prefix = `${job.name}_`;
  return entries
    .filter((entry) => entry.startsWith(prefix))
    .map((filename) => {
      const fullPath = path.join(job.outputDir, filename);
      const stat = fs.statSync(fullPath);
      return { filename, path: fullPath, size: stat.size, mtimeMs: stat.mtimeMs };
    })
    .filter((f) => fs.statSync(f.path).isFile())
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Resolve o caminho de um backup pelo nome do arquivo, validando que pertence a esse job. */
export function resolveBackupFile(job: JobConfig, filename: string): string | null {
  const match = listBackupFiles(job).find((f) => f.filename === filename);
  return match ? match.path : null;
}

/** Apaga backups mais antigos que a retencao configurada. Comum aos dois tipos de job — so
 * depende de name/outputDir/retentionDays, presentes nos dois. */
export function cleanupOldBackups(job: JobConfig, jobLog: JobLogger): void {
  if (job.retentionDays <= 0) return;
  const cutoff = Date.now() - job.retentionDays * 24 * 60 * 60 * 1000;

  for (const file of listBackupFiles(job)) {
    if (file.mtimeMs < cutoff) {
      fs.rmSync(file.path, { force: true });
      jobLog.info(`Removido backup antigo (retencao ${job.retentionDays}d): ${file.path}`);
    }
  }
}

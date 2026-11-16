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

/**
 * Sufixo do arquivo enquanto o backup esta sendo gravado. So depois de terminar (e de os dados
 * estarem no disco) ele e renomeado pro nome final — assim um backup pela metade nunca aparece
 * como backup valido: nem na UI (download, "ultimo backup", selo de tamanho), nem pro self-heal,
 * nem depois de um kill -9 / queda de energia no meio da gravacao.
 */
export const PARTIAL_SUFFIX = ".partial";

export function partialPathFor(outputFile: string): string {
  return outputFile + PARTIAL_SUFFIX;
}

/**
 * Conclui um backup: permissao 600, fsync (garante que os bytes estao no disco antes de o arquivo
 * "existir" com o nome final) e rename atomico de .partial pro nome definitivo. Devolve o tamanho.
 */
export function finalizeBackupFile(partialFile: string, outputFile: string): number {
  fs.chmodSync(partialFile, 0o600);
  const fd = fs.openSync(partialFile, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(partialFile, outputFile);
  return fs.statSync(outputFile).size;
}

function listJobEntries(job: JobConfig): string[] {
  try {
    return fs.readdirSync(job.outputDir).filter((entry) => entry.startsWith(`${job.name}_`));
  } catch {
    return [];
  }
}

/** Lista os arquivos de backup (concluidos) de um job, mais recentes primeiro. */
export function listBackupFiles(job: JobConfig): BackupFile[] {
  const files: BackupFile[] = [];
  for (const filename of listJobEntries(job)) {
    if (filename.endsWith(PARTIAL_SUFFIX)) continue;
    const fullPath = path.join(job.outputDir, filename);
    try {
      const stat = fs.statSync(fullPath);
      if (stat.isFile()) files.push({ filename, path: fullPath, size: stat.size, mtimeMs: stat.mtimeMs });
    } catch {
      // apagado entre o readdir e o stat (retencao/UI rodando ao mesmo tempo) — ignora
    }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Resolve o caminho de um backup pelo nome do arquivo, validando que pertence a esse job. */
export function resolveBackupFile(job: JobConfig, filename: string): string | null {
  const match = listBackupFiles(job).find((f) => f.filename === filename);
  return match ? match.path : null;
}

/**
 * Apaga backups mais antigos que a retencao configurada e sobras .partial de runs que morreram no
 * meio. Comum aos dois tipos de job. Chamado so por quem acabou de concluir um backup e ainda
 * segura o lock do job — entao nenhum .partial que sobrou pertence a um run em andamento.
 *
 * Nunca lanca: uma falha aqui (permissao, arquivo sumiu) nao pode transformar um backup que deu
 * certo em "falhou" — e o tratamento de erro do runner apagaria justamente o backup novo.
 */
export function cleanupOldBackups(job: JobConfig, jobLog: JobLogger): void {
  try {
    for (const filename of listJobEntries(job)) {
      if (!filename.endsWith(PARTIAL_SUFFIX)) continue;
      fs.rmSync(path.join(job.outputDir, filename), { force: true });
      jobLog.info(`Removida sobra de backup interrompido: ${filename}`);
    }

    if (job.retentionDays <= 0) return;
    const cutoff = Date.now() - job.retentionDays * 24 * 60 * 60 * 1000;
    for (const file of listBackupFiles(job)) {
      if (file.mtimeMs < cutoff) {
        fs.rmSync(file.path, { force: true });
        jobLog.info(`Removido backup antigo (retencao ${job.retentionDays}d): ${file.path}`);
      }
    }
  } catch (err) {
    jobLog.error(`Job "${job.name}": falha na limpeza de backups antigos: ${(err as Error).message}`);
  }
}

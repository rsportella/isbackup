import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { spawn } from "node:child_process";
import type { DatabaseJobConfig } from "./types.js";
import { cleanupOldBackups } from "./backups.js";
import { writeRunLock, clearRunLock, isCancelRequested, clearCancelRequest, RunCancelledError } from "./run-lock.js";
import { timestampForFilename, formatBytes } from "./format.js";
import { createJobLogger } from "./job-log.js";

export interface RunBackupOptions {
  dryRun?: boolean;
  /** Pasta onde gravar logs/<job>.log — sempre obrigatorio, pra o Historico da UI ter
   * visibilidade do que aconteceu independente de quem disparou o run (cron, self-heal, UI). */
  logDir: string;
}

/**
 * Credenciais vao em um arquivo temporario --defaults-extra-file (0600, apagado no finally)
 * em vez de -p na linha de comando, que fica visivel em `ps aux` para qualquer usuario local.
 */
function writeCredentialsFile(job: DatabaseJobConfig): string {
  const file = path.join(
    os.tmpdir(),
    `isbackup-${job.name}-${process.pid}-${crypto.randomBytes(6).toString("hex")}.cnf`,
  );
  const content = [
    "[client]",
    `host=${job.host}`,
    `port=${job.port}`,
    `user=${job.user}`,
    `password=${job.password}`,
    "",
  ].join("\n");
  fs.writeFileSync(file, content, { mode: 0o600 });
  return file;
}

function buildArgs(job: DatabaseJobConfig, credentialsFile: string): string[] {
  const args = [
    `--defaults-extra-file=${credentialsFile}`,
    "--single-transaction",
    "--quick",
    "--routines",
    "--triggers",
  ];
  if (job.databases === "all") {
    args.push("--all-databases");
  } else {
    args.push("--databases", ...job.databases);
  }
  return args;
}

// cron (e outros agendadores) rodam com um PATH minimo, que normalmente nao inclui
// onde o Homebrew instala o mysql-client (e "keg-only", nem fica em /opt/homebrew/bin).
// Isso fazia o job falhar so quando disparado pelo cron, mesmo com mysqldump instalado.
const FALLBACK_MYSQLDUMP_DIRS = [
  "/opt/homebrew/opt/mysql-client/bin", // Homebrew, Apple Silicon (mysql-client e keg-only)
  "/opt/homebrew/bin",
  "/usr/local/opt/mysql-client/bin", // Homebrew, Intel
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
];

export function spawnEnvWithFallbackPath(extraDirs: string[] = FALLBACK_MYSQLDUMP_DIRS): NodeJS.ProcessEnv {
  const current = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const merged = [...new Set([...current, ...extraDirs])];
  return { ...process.env, PATH: merged.join(path.delimiter) };
}

// Checa o pedido de cancelamento nesse intervalo enquanto o mysqldump roda — nao ha "callback de
// progresso" natural num dump (e so um stream), entao precisa de um polling proprio (mesma ideia
// do que ja existe pro progresso de download em file-backup.ts).
const CANCEL_CHECK_INTERVAL_MS = 500;

function runMysqldump(job: DatabaseJobConfig, credentialsFile: string, outputFile: string): Promise<void> {
  const args = buildArgs(job, credentialsFile);

  return new Promise<void>((resolve, reject) => {
    const child = spawn("mysqldump", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: spawnEnvWithFallbackPath(),
    });

    let stderrOutput = "";
    let settled = false;
    const cancelCheck = setInterval(() => {
      if (isCancelRequested(job)) child.kill("SIGTERM");
    }, CANCEL_CHECK_INTERVAL_MS);

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearInterval(cancelCheck);
      reject(err);
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      clearInterval(cancelCheck);
      resolve();
    };

    child.stderr.on("data", (chunk: Buffer) => {
      stderrOutput += chunk.toString();
    });

    child.on("error", (err) => {
      fail(
        new Error(
          `Nao foi possivel executar "mysqldump": ${err.message}. Verifique se o mysql-client esta instalado e no PATH.`,
        ),
      );
    });

    const outStream = fs.createWriteStream(outputFile, { mode: 0o600 });
    outStream.on("error", fail);

    if (job.gzip) {
      const gzip = zlib.createGzip();
      gzip.on("error", fail);
      child.stdout.pipe(gzip).pipe(outStream);
    } else {
      child.stdout.pipe(outStream);
    }

    child.on("close", (code, signal) => {
      if (code === 0) {
        succeed();
      } else if (isCancelRequested(job) && signal) {
        fail(new RunCancelledError());
      } else {
        fail(new Error(`mysqldump saiu com codigo ${code}.${stderrOutput ? " Detalhes: " + stderrOutput.trim() : ""}`));
      }
    });
  });
}

export async function runBackup(job: DatabaseJobConfig, options: RunBackupOptions): Promise<string | null> {
  const jobLog = createJobLogger(options.logDir, job.name);
  const ts = timestampForFilename();
  const ext = job.gzip ? ".sql.gz" : ".sql";
  const outputFile = path.join(job.outputDir, `${job.name}_${ts}${ext}`);
  const dbLabel = job.databases === "all" ? "todos os bancos" : job.databases.join(", ");

  if (options.dryRun) {
    jobLog.info(
      `[dry-run] job "${job.name}": mysqldump em ${job.host}:${job.port} (usuario ${job.user}) -> ${outputFile} (${dbLabel})`,
    );
    return null;
  }

  fs.mkdirSync(job.outputDir, { recursive: true });
  writeRunLock(job);
  const credentialsFile = writeCredentialsFile(job);
  try {
    jobLog.info(`Iniciando backup do job "${job.name}" (${dbLabel}) de ${job.host}:${job.port}...`);
    await runMysqldump(job, credentialsFile, outputFile);
    const { size } = fs.statSync(outputFile);
    jobLog.info(`Backup do job "${job.name}" concluido: ${outputFile} (${formatBytes(size)})`);
    cleanupOldBackups(job, jobLog);
    return outputFile;
  } catch (err) {
    if (err instanceof RunCancelledError) {
      jobLog.info(`Job "${job.name}" cancelado pelo usuario.`);
    } else {
      jobLog.error(`Job "${job.name}" falhou: ${(err as Error).message}`);
    }
    fs.rmSync(outputFile, { force: true });
    throw err;
  } finally {
    fs.rmSync(credentialsFile, { force: true });
    clearRunLock(job);
    clearCancelRequest(job);
  }
}

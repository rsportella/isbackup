import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import type { DatabaseJobConfig } from "./types.js";
import { cleanupOldBackups, finalizeBackupFile, partialPathFor } from "./backups.js";
import { writeMysqlOptionsFile } from "./mysql-credentials.js";
import { acquireRunLock, clearRunLock, isCancelRequested, clearCancelRequest, RunCancelledError } from "./run-lock.js";
import { timestampForFilename, formatBytes } from "./format.js";
import { createJobLogger } from "./job-log.js";

export interface RunBackupOptions {
  dryRun?: boolean;
  /** Pasta onde gravar logs/<job>.log — sempre obrigatorio, pra o Historico da UI ter
   * visibilidade do que aconteceu independente de quem disparou o run (cron, self-heal, UI). */
  logDir: string;
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

/**
 * Roda o mysqldump gravando em `targetFile`, e so resolve quando as DUAS coisas terminaram: o
 * processo saiu com sucesso E o ultimo byte (ja comprimido) foi escrito no arquivo.
 *
 * Antes resolvia no "close" do processo, que acontece antes de o gzip/arquivo terminarem de
 * despejar o que ainda estava em buffer: o tamanho logado saia menor que o real e, pior, um erro
 * de escrita nesse finalzinho (ex: disco cheio) era ignorado — um dump truncado virava "sucesso".
 */
async function runMysqldump(job: DatabaseJobConfig, credentialsFile: string, targetFile: string): Promise<void> {
  const child = spawn("mysqldump", buildArgs(job, credentialsFile), {
    stdio: ["ignore", "pipe", "pipe"],
    env: spawnEnvWithFallbackPath(),
  });

  let stderrOutput = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderrOutput += chunk.toString();
  });

  const cancelCheck = setInterval(() => {
    if (isCancelRequested(job)) child.kill("SIGTERM");
  }, CANCEL_CHECK_INTERVAL_MS);

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.on("error", (err) =>
      reject(
        new Error(
          `Nao foi possivel executar "mysqldump": ${err.message}. Verifique se o mysql-client esta instalado e no PATH.`,
        ),
      ),
    );
    child.on("close", (code, signal) => resolve({ code, signal }));
  });

  const outStream = fs.createWriteStream(targetFile, { mode: 0o600 });
  // pipeline so resolve depois que o arquivo foi totalmente escrito e fechado, e rejeita com
  // qualquer erro de leitura, compressao ou escrita.
  const written = job.gzip ? pipeline(child.stdout, zlib.createGzip(), outStream) : pipeline(child.stdout, outStream);

  // Falha de escrita com o mysqldump ainda rodando (ex: disco cheio): encerra o processo, senao
  // ele ficaria esperando alguem ler a saida pra sempre.
  written.catch(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  });

  try {
    // Espera os dois (sem curto-circuito) pra reportar a causa certa, na ordem de prioridade abaixo.
    const [exitResult, writeResult] = await Promise.allSettled([exited, written]);
    if (exitResult.status === "rejected") throw exitResult.reason; // mysqldump nem rodou
    const { code, signal } = exitResult.value;
    if (signal && isCancelRequested(job)) throw new RunCancelledError();
    if (writeResult.status === "rejected") {
      throw new Error(`Falha ao gravar o arquivo de backup: ${(writeResult.reason as Error).message}`);
    }
    if (code !== 0) {
      throw new Error(`mysqldump saiu com codigo ${code}.${stderrOutput ? " Detalhes: " + stderrOutput.trim() : ""}`);
    }
  } finally {
    clearInterval(cancelCheck);
  }
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
  acquireRunLock(job, jobLog);
  const partialFile = partialPathFor(outputFile);
  let credentialsFile: string | null = null;
  try {
    // Dentro do try: se isso falhar, o finally ainda solta o lock (antes ficava preso).
    credentialsFile = writeMysqlOptionsFile(job, job.name);
    jobLog.info(`Iniciando backup do job "${job.name}" (${dbLabel}) de ${job.host}:${job.port}...`);
    await runMysqldump(job, credentialsFile, partialFile);
    const size = finalizeBackupFile(partialFile, outputFile);
    jobLog.info(`Backup do job "${job.name}" concluido: ${outputFile} (${formatBytes(size)})`);
    cleanupOldBackups(job, jobLog);
    return outputFile;
  } catch (err) {
    if (err instanceof RunCancelledError) {
      jobLog.info(`Job "${job.name}" cancelado pelo usuario.`);
    } else {
      jobLog.error(`Job "${job.name}" falhou: ${(err as Error).message}`);
    }
    fs.rmSync(partialFile, { force: true });
    throw err;
  } finally {
    if (credentialsFile) fs.rmSync(credentialsFile, { force: true });
    clearRunLock(job);
    clearCancelRequest(job);
  }
}

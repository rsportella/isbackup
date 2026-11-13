import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { FileSourceConfig, FilesJobConfig } from "./types.js";
import { cleanupOldBackups } from "./backups.js";
import {
  writeRunLock,
  clearRunLock,
  updateRunProgress,
  updateRunPhase,
  isCancelRequested,
  clearCancelRequest,
  RunCancelledError,
} from "./run-lock.js";
import { timestampForFilename, formatBytes } from "./format.js";
import { createJobLogger } from "./job-log.js";
import { spawnEnvWithFallbackPath } from "./dump.js";
import type { RunBackupOptions } from "./dump.js";

interface RemoteFile {
  /** Caminho relativo a remoteDir (posix, com "/"), preservado no .tar.gz — evita colisao de
   * nome entre arquivos de mesmo nome em subpastas diferentes (comum em estruturas de backup
   * datadas, ex: "2026-09-18 (Completo)/dump.zip" e "2026-09-19 (Completo)/dump.zip"). */
  relativePath: string;
  /** So o nome do arquivo (sem o caminho), usado nos filtros de pattern/nameContains. */
  name: string;
  size: number;
  mtimeMs: number;
}

// Origem tipica desse job (estrutura de backup ja existente no servidor remoto) costuma ter
// pastas datadas por dentro de pastas datadas — precisa descer alguns niveis pra achar arquivo de
// verdade, mas um teto evita entrar numa arvore patologicamente funda (ou um link simbolico
// ciclico, em SFTP).
const MAX_RECURSION_DEPTH = 10;

/** Converte um wildcard simples (so "*") num RegExp. Sem dependencia nova — o pedido original
 * so menciona "*", nao glob completo (**, ?, character classes). */
function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

function modifiedCutoffMs(source: FileSourceConfig): number | null {
  return source.modifiedWithinDays !== null ? Date.now() - source.modifiedWithinDays * 24 * 60 * 60 * 1000 : null;
}

function matchesFilters(file: RemoteFile, source: FileSourceConfig, cutoffMs: number | null): boolean {
  if (source.pattern && source.pattern !== "*" && !wildcardToRegExp(source.pattern).test(file.name)) {
    return false;
  }
  if (source.nameContains && !file.name.toLowerCase().includes(source.nameContains.toLowerCase())) {
    return false;
  }
  if (cutoffMs !== null && file.mtimeMs < cutoffMs) return false;
  return true;
}

async function walkSftp(
  sftp: any,
  dir: string,
  baseDir: string,
  depth: number,
  cutoffMs: number | null,
  job: FilesJobConfig,
): Promise<RemoteFile[]> {
  if (depth > MAX_RECURSION_DEPTH) return [];
  if (isCancelRequested(job)) throw new RunCancelledError();
  const entries = await sftp.list(dir);
  const results: RemoteFile[] = [];
  for (const e of entries) {
    const fullPath = path.posix.join(dir, e.name);
    if (e.type === "-") {
      results.push({
        relativePath: path.posix.relative(baseDir, fullPath),
        name: e.name,
        size: e.size,
        mtimeMs: e.modifyTime,
      });
    } else if (e.type === "d") {
      // Com um filtro de "modificado nos ultimos N dias", pula pastas cuja propria data de
      // modificacao ja esta fora da janela — evita descer em anos de pastas antigas so pra
      // descobrir que nada la dentro bate no filtro (essencial pra estruturas tipo backup datado
      // com muitas pastas, uma por dia/rodada: sem essa poda, listar a arvore inteira antes de
      // filtrar pode levar minutos). So entra em acao quando ha filtro de data explicito — sem
      // ele, escaneia tudo como antes.
      if (cutoffMs !== null && e.modifyTime < cutoffMs) continue;
      results.push(...(await walkSftp(sftp, fullPath, baseDir, depth + 1, cutoffMs, job)));
    }
    // links simbolicos ("l") ficam de fora — evita ciclos e complexidade extra pra um caso raro
  }
  return results;
}

async function listSftp(source: FileSourceConfig, job: FilesJobConfig): Promise<RemoteFile[]> {
  const { default: SftpClient } = await import("ssh2-sftp-client");
  const sftp = new SftpClient();
  try {
    await sftp.connect({ host: source.host, port: source.port, username: source.user, password: source.password });
    return await walkSftp(sftp, source.remoteDir, source.remoteDir, 0, modifiedCutoffMs(source), job);
  } finally {
    await sftp.end().catch(() => {});
  }
}

async function downloadSftp(
  source: FileSourceConfig,
  files: RemoteFile[],
  stagingDir: string,
  job: FilesJobConfig,
  onProgress: (bytesDone: number, filesDone: number, force?: boolean) => void,
): Promise<void> {
  const { default: SftpClient } = await import("ssh2-sftp-client");
  const sftp = new SftpClient();
  let cancelled = false;
  try {
    await sftp.connect({ host: source.host, port: source.port, username: source.user, password: source.password });
    let bytesDoneBefore = 0;
    let filesDone = 0;
    for (const file of files) {
      if (isCancelRequested(job)) throw new RunCancelledError();
      const remotePath = path.posix.join(source.remoteDir, file.relativePath);
      const localPath = path.join(stagingDir, file.relativePath);
      fs.mkdirSync(path.dirname(localPath), { recursive: true });
      await sftp.fastGet(remotePath, localPath, {
        step: (totalTransferred: number) => {
          // fastGet nao tem um jeito direto de abortar no meio — fechar a conexao faz a promise
          // rejeitar, e o catch abaixo troca isso por um RunCancelledError.
          if (!cancelled && isCancelRequested(job)) {
            cancelled = true;
            sftp.end().catch(() => {});
            return;
          }
          onProgress(bytesDoneBefore + totalTransferred, filesDone);
        },
      });
      bytesDoneBefore += file.size;
      filesDone += 1;
      onProgress(bytesDoneBefore, filesDone, true);
    }
  } catch (err) {
    if (cancelled) throw new RunCancelledError();
    throw err;
  } finally {
    await sftp.end().catch(() => {});
  }
}

const UNIX_LIST_MONTHS: Record<string, number> = {
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11,
};

/**
 * Parseia a data do formato classico do `ls -l` unix, que e o que servidores FTP sem suporte a
 * MLSD devolvem (e a maioria nao suporta): "MMM DD HH:MM" pra arquivos recentes (ano implicito —
 * o ano NAO aparece) ou "MMM DD  YYYY" pra arquivos mais antigos (sem hora). `new Date(raw)` do
 * JS nao da conta do primeiro formato (chuta um ano arbitrario tipo 2001), entao precisa de um
 * parser proprio — mesma ambiguidade que o `ls -l` em si tem, resolvida do mesmo jeito: se a
 * data com o ano atual cair no futuro, o ano certo e o anterior.
 */
function parseUnixListDate(raw: string, now: Date): number | null {
  const withTime = /^([A-Za-z]{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (withTime) {
    const month = UNIX_LIST_MONTHS[withTime[1]];
    if (month === undefined) return null;
    const day = Number(withTime[2]);
    const hour = Number(withTime[3]);
    const minute = Number(withTime[4]);
    const year = now.getFullYear();
    let candidate = new Date(year, month, day, hour, minute).getTime();
    if (candidate > now.getTime() + 24 * 60 * 60 * 1000) {
      candidate = new Date(year - 1, month, day, hour, minute).getTime();
    }
    return candidate;
  }

  const withYear = /^([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4})$/.exec(raw.trim());
  if (withYear) {
    const month = UNIX_LIST_MONTHS[withYear[1]];
    if (month === undefined) return null;
    return new Date(Number(withYear[3]), month, Number(withYear[2])).getTime();
  }

  return null;
}

function ftpEntryMtimeMs(e: { modifiedAt?: Date; rawModifiedAt: string }): number {
  // Prefere modifiedAt (Date ja parseada pela lib, quando o servidor suporta MLSD); cai pro
  // parser proprio de "MMM DD HH:MM"/"MMM DD YYYY" (formato classico do `ls -l`, sem ano em
  // arquivos recentes) quando so ha rawModifiedAt — a maioria dos servidores FTP nao suporta
  // MLSD, entao esse fallback e o caminho comum, nao a excecao.
  return e.modifiedAt?.getTime() ?? (e.rawModifiedAt ? (parseUnixListDate(e.rawModifiedAt, new Date()) ?? 0) : 0);
}

async function walkFtp(
  client: any,
  dir: string,
  baseDir: string,
  depth: number,
  cutoffMs: number | null,
  job: FilesJobConfig,
): Promise<RemoteFile[]> {
  if (depth > MAX_RECURSION_DEPTH) return [];
  if (isCancelRequested(job)) throw new RunCancelledError();
  const entries = await client.list(dir);
  const results: RemoteFile[] = [];
  for (const e of entries) {
    const fullPath = path.posix.join(dir, e.name);
    if (e.isFile) {
      results.push({
        relativePath: path.posix.relative(baseDir, fullPath),
        name: e.name,
        size: e.size,
        mtimeMs: ftpEntryMtimeMs(e),
      });
    } else if (e.isDirectory) {
      // Mesma poda do lado SFTP: pasta mais antiga que o corte de "modificado nos ultimos N
      // dias" nao e visitada.
      if (cutoffMs !== null && ftpEntryMtimeMs(e) < cutoffMs) continue;
      results.push(...(await walkFtp(client, fullPath, baseDir, depth + 1, cutoffMs, job)));
    }
    // symlinks ficam de fora, mesmo motivo do lado SFTP
  }
  return results;
}

async function listFtp(source: FileSourceConfig, job: FilesJobConfig): Promise<RemoteFile[]> {
  const { Client } = await import("basic-ftp");
  const client = new Client();
  try {
    await client.access({ host: source.host, port: source.port, user: source.user, password: source.password, secure: source.secure });
    return await walkFtp(client, source.remoteDir, source.remoteDir, 0, modifiedCutoffMs(source), job);
  } finally {
    client.close();
  }
}

async function downloadFtp(
  source: FileSourceConfig,
  files: RemoteFile[],
  stagingDir: string,
  job: FilesJobConfig,
  onProgress: (bytesDone: number, filesDone: number, force?: boolean) => void,
): Promise<void> {
  const { Client } = await import("basic-ftp");
  const client = new Client();
  let cancelled = false;
  try {
    await client.access({ host: source.host, port: source.port, user: source.user, password: source.password, secure: source.secure });
    let filesDone = 0;
    // bytesOverall acumula sozinho entre chamadas de downloadTo, desde que trackProgress so seja
    // chamado uma vez (nao reseta o contador a cada arquivo).
    client.trackProgress((info) => {
      // downloadTo nao tem um jeito direto de abortar no meio — fechar a conexao faz a promise
      // rejeitar, e o catch abaixo troca isso por um RunCancelledError.
      if (!cancelled && isCancelRequested(job)) {
        cancelled = true;
        client.close();
        return;
      }
      onProgress(info.bytesOverall, filesDone);
    });
    let bytesDoneBefore = 0;
    for (const file of files) {
      if (isCancelRequested(job)) throw new RunCancelledError();
      const remotePath = path.posix.join(source.remoteDir, file.relativePath);
      const localPath = path.join(stagingDir, file.relativePath);
      fs.mkdirSync(path.dirname(localPath), { recursive: true });
      await client.downloadTo(localPath, remotePath);
      bytesDoneBefore += file.size;
      filesDone += 1;
      onProgress(bytesDoneBefore, filesDone, true);
    }
  } catch (err) {
    if (cancelled) throw new RunCancelledError();
    throw err;
  } finally {
    client.trackProgress(); // para de rastrear
    client.close();
  }
}

const FALLBACK_TAR_DIRS = ["/usr/bin", "/bin"];

/** Compacta um diretorio inteiro num .tar.gz, chamando o `tar` do sistema (mesmo padrao ja usado
 * pro mysqldump: shell out a um binario bem conhecido, em vez de trazer uma dependencia de
 * archiving so pra isso). */
function createTarGz(stagingDir: string, outputFile: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", ["-czf", outputFile, "-C", stagingDir, "."], {
      stdio: ["ignore", "pipe", "pipe"],
      env: spawnEnvWithFallbackPath(FALLBACK_TAR_DIRS),
    });

    let stderrOutput = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderrOutput += chunk.toString();
    });
    child.on("error", (err) => {
      reject(new Error(`Nao foi possivel executar "tar": ${err.message}.`));
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar saiu com codigo ${code}.${stderrOutput ? " Detalhes: " + stderrOutput.trim() : ""}`));
    });
  });
}

/**
 * Testa uma origem SFTP/FTP — conecta e confirma que o diretorio remoto existe/e acessivel, sem
 * baixar nada. Usado pelo botao "Testar conexao" do formulario, antes de habilitar "Salvar".
 */
export async function testFileSourceConnection(source: FileSourceConfig): Promise<void> {
  if (source.protocol === "sftp") {
    const { default: SftpClient } = await import("ssh2-sftp-client");
    const sftp = new SftpClient();
    try {
      await sftp.connect({ host: source.host, port: source.port, username: source.user, password: source.password });
      const exists = await sftp.exists(source.remoteDir);
      if (!exists) throw new Error(`Diretorio "${source.remoteDir}" nao encontrado no servidor.`);
    } finally {
      await sftp.end().catch(() => {});
    }
  } else {
    const { Client } = await import("basic-ftp");
    const client = new Client();
    try {
      await client.access({
        host: source.host,
        port: source.port,
        user: source.user,
        password: source.password,
        secure: source.secure,
      });
      await client.cd(source.remoteDir);
    } finally {
      client.close();
    }
  }
}

export async function runFileBackup(job: FilesJobConfig, options: RunBackupOptions): Promise<string | null> {
  const jobLog = createJobLogger(options.logDir, job.name);
  const ts = timestampForFilename();
  const outputFile = path.join(job.outputDir, `${job.name}_${ts}.tar.gz`);
  const source = job.fileSource;

  if (options.dryRun) {
    jobLog.info(
      `[dry-run] job "${job.name}": ${source.protocol} em ${source.host}:${source.port} (${source.remoteDir}, padrao "${source.pattern}") -> ${outputFile}`,
    );
    return null;
  }

  fs.mkdirSync(job.outputDir, { recursive: true });
  writeRunLock(job);
  let stagingDir: string | null = null;
  try {
    jobLog.info(`Iniciando backup de arquivos do job "${job.name}" via ${source.protocol} (${source.host})...`);
    const allFiles = source.protocol === "sftp" ? await listSftp(source, job) : await listFtp(source, job);
    const matched = allFiles.filter((f) => matchesFilters(f, source, modifiedCutoffMs(source)));

    if (matched.length === 0) {
      jobLog.info(`Job "${job.name}": nenhum arquivo remoto bateu com os filtros configurados (de ${allFiles.length} listado(s)).`);
    }

    // Progresso (bytes baixados/total) so faz sentido pra job de arquivos — da pra saber o
    // tamanho total antes de comecar (ao contrario do dump de banco, que e um stream sem total
    // conhecido). Throttled: nao precisa escrever no lock a cada callback (pode disparar muitas
    // vezes por segundo num arquivo grande), so dar uma nocao real de "esta andando".
    const bytesTotal = matched.reduce((sum, f) => sum + f.size, 0);
    const filesTotal = matched.length;
    let lastProgressWriteAt = 0;
    const PROGRESS_THROTTLE_MS = 700;
    // `force` ignora o throttle — usado no marco exato de cada arquivo concluido, pra nao correr
    // o risco de esse valor cair bem dentro da janela de throttle e nunca ser gravado (deixando
    // o progresso "congelado" numa amostra antiga ate o job inteiro terminar, mesmo com o
    // download ja avancando de verdade por baixo).
    const reportProgress = (bytesDone: number, filesDone: number, force = false) => {
      const now = Date.now();
      if (!force && now - lastProgressWriteAt < PROGRESS_THROTTLE_MS) return;
      lastProgressWriteAt = now;
      updateRunProgress(job, { bytesDone, bytesTotal, filesDone, filesTotal });
    };

    stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), `isbackup-${job.name}-`));
    if (source.protocol === "sftp") {
      await downloadSftp(source, matched, stagingDir, job, reportProgress);
    } else {
      await downloadFtp(source, matched, stagingDir, job, reportProgress);
    }

    if (matched.length > 0) updateRunPhase(job, "compressing");
    await createTarGz(stagingDir, outputFile);
    const { size } = fs.statSync(outputFile);
    jobLog.info(
      `Backup de arquivos do job "${job.name}" concluido: ${outputFile} (${formatBytes(size)}, ${matched.length} arquivo(s))`,
    );
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
    if (stagingDir) fs.rmSync(stagingDir, { recursive: true, force: true });
    clearRunLock(job);
    clearCancelRequest(job);
  }
}

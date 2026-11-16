import fs from "node:fs";
import path from "node:path";
import { Router, type Request, type Response } from "express";
import { loadConfig, readRawConfig, writeRawConfig } from "../config.js";
import { readRunLock, requestCancel } from "../run-lock.js";
import { listBackupFiles, resolveBackupFile } from "../backups.js";
import {
  applyCrontab,
  buildManagedBlock,
  buildNewCrontab,
  extractManagedBlock,
  readCurrentCrontab,
  resolveSchedule,
  type CronContext,
} from "../cron.js";
import { logger } from "../logger.js";
import type { JobConfig } from "../types.js";
import { getJobState } from "./state.js";
import { triggerJobRun } from "./run-trigger.js";
import {
  computeNextRun,
  computeScheduleStatus,
  estimateRetainedCount,
  estimateRunsPerDay,
} from "../schedule-status.js";
import { getOrCreateEncryptionKey } from "../env-writer.js";
import { encrypt } from "../crypto.js";
import { testDatabaseConnection } from "../connection-test.js";
import { testFileSourceConnection } from "../file-backup.js";
import { readLastLines } from "../job-log.js";
import {
  currentBackupDir,
  ensureWritableDir,
  freeBytes,
  getMoveStatus,
  hostPathFor,
  isDocker,
  normalizeUserPath,
  SettingsError,
  startMovingBackups,
  suggestedDirs,
} from "./settings.js";
import {
  buildConnectionTestTarget,
  buildRawJob,
  JobInputError,
  mergeEditedJob,
  parseJobName,
  type JobInputBody,
} from "./job-input.js";

export interface ApiOptions {
  configPath: string;
  projectRoot: string;
  /** .env com a chave de cifra. Padrao: <projectRoot>/.env (a CLI passa o da pasta de dados). */
  envPath?: string;
  logDir: string;
}

export interface SizeTrend {
  /** "ok": ultimo backup do mesmo tamanho, maior, ou so um pouco menor que o anterior. "warning":
   * encolheu alem da tolerancia (indicio de falha silenciosa). "unknown": sem base de comparacao
   * (0 ou 1 backup ainda). */
  status: "ok" | "warning" | "unknown";
  lastSize: number;
  previousSize: number | null;
}

/** Abaixo dessa fracao do backup anterior, o novo backup e considerado suspeito. */
export const SIZE_DROP_WARNING_RATIO = 0.8;

/**
 * Compara o tamanho do ultimo backup com o penultimo. Um dump que encolhe muito de uma vez e
 * sinal de que pode ter falhado silenciosamente (conexao caiu no meio, disco cheio, etc).
 *
 * Antes qualquer backup igual ou menor ja virava alerta — mas banco tambem encolhe (limpeza de
 * logs/sessoes, DELETE de dados antigos) e a compressao varia um pouco de um dump pro outro, o
 * que gerava falso positivo constante. Agora so alerta quando cai abaixo de 80% do anterior.
 */
export function computeSizeTrend(files: { size: number }[]): SizeTrend {
  const last = files[0];
  const previous = files[1];
  if (!last || !previous) {
    return { status: "unknown", lastSize: last ? last.size : 0, previousSize: null };
  }
  return {
    status: last.size >= previous.size * SIZE_DROP_WARNING_RATIO ? "ok" : "warning",
    lastSize: last.size,
    previousSize: previous.size,
  };
}

// O cron dispara execucoes num processo separado do servidor da UI, entao o estado em memoria
// (setJobState/getJobState) so cobre runs disparados pela propria UI. O lock em disco (dump.ts)
// cobre os dois casos — se ele existir (e o pid ainda estiver vivo), o job esta rodando agora,
// independente de quem disparou.
function computeRunState(job: JobConfig) {
  const lock = readRunLock(job);
  if (lock) {
    return {
      status: "running" as const,
      startedAt: lock.startedAt,
      progress: lock.progress ?? null,
      phase: lock.phase ?? null,
    };
  }
  return getJobState(job.name);
}

function jobSummary(job: JobConfig) {
  const files = listBackupFiles(job);
  const last = files[0];
  const resolvedSchedule = resolveSchedule(job.schedule);
  const scheduleStatus = computeScheduleStatus(resolvedSchedule, last ? last.mtimeMs : null);

  // Campos especificos do tipo do job (banco: host/port/user/databases/gzip, como sempre;
  // arquivos: fileSource allowlist — nunca inclui fileSource.password, mesmo padrao de nunca
  // vazar segredo ja usado pra job.password hoje).
  const typeFields =
    job.type === "files"
      ? {
          type: "files" as const,
          fileSource: {
            protocol: job.fileSource.protocol,
            host: job.fileSource.host,
            port: job.fileSource.port,
            user: job.fileSource.user,
            remoteDir: job.fileSource.remoteDir,
            pattern: job.fileSource.pattern,
            nameContains: job.fileSource.nameContains,
            modifiedWithinDays: job.fileSource.modifiedWithinDays,
            secure: job.fileSource.secure,
          },
        }
      : {
          type: "database" as const,
          host: job.host,
          port: job.port,
          user: job.user,
          databases: job.databases,
          gzip: job.gzip,
        };

  return {
    name: job.name,
    ...typeFields,
    schedule: job.schedule,
    resolvedSchedule,
    outputDir: job.outputDir,
    retentionDays: job.retentionDays,
    paused: job.paused,
    backupCount: files.length,
    totalSize: files.reduce((sum, f) => sum + f.size, 0),
    lastBackup: last
      ? { filename: last.filename, size: last.size, mtime: new Date(last.mtimeMs).toISOString() }
      : null,
    sizeTrend: computeSizeTrend(files),
    runState: computeRunState(job),
    scheduleHealth: scheduleStatus.health,
    expectedSince: scheduleStatus.expectedSince,
    nextRun: computeNextRun(resolvedSchedule),
    estimatedRetainedCount: estimateRetainedCount(resolvedSchedule, job.retentionDays),
  };
}

function findJobOr404(req: Request, res: Response, opts: ApiOptions): JobConfig | null {
  let jobs: JobConfig[];
  try {
    jobs = loadConfig(opts.configPath);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return null;
  }

  const job = jobs.find((j) => j.name === req.params.name);
  if (!job) {
    res.status(404).json({ error: `Job "${req.params.name}" nao encontrado.` });
    return null;
  }
  return job;
}

/** Cifra a senha com a chave mestre (.env), pra gravar direto no config.yaml. */
function passwordEncrypter(envPath: string): (plain: string) => string {
  return (plain) => encrypt(plain, getOrCreateEncryptionKey(envPath));
}

/** 400 pra erro de validacao/config; o resto (bug, I/O inesperado) vira 500. */
function sendError(res: Response, err: unknown): void {
  const message = (err as Error).message;
  const isClientError = err instanceof JobInputError || !(err instanceof Error) || err.name === "Error";
  res.status(isClientError ? 400 : 500).json({ error: message });
}

export function createApiRouter(opts: ApiOptions): Router {
  const router = Router();

  const cronCtx = (): CronContext => ({
    projectRoot: opts.projectRoot,
    configPath: path.resolve(opts.configPath),
    logDir: opts.logDir,
  });
  const envPath = opts.envPath ?? path.join(opts.projectRoot, ".env");

  router.get("/jobs", (_req, res) => {
    try {
      const jobs = loadConfig(opts.configPath);
      res.json(jobs.map(jobSummary));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.post("/jobs", (req, res) => {
    try {
      const body = req.body as JobInputBody;
      const name = parseJobName(body.name);

      const raw = readRawConfig(opts.configPath);
      if (raw.jobs.some((j) => j.name === name)) {
        res.status(409).json({ error: `Ja existe um job chamado "${name}".` });
        return;
      }

      raw.jobs.push(buildRawJob(name, body, { encryptPassword: passwordEncrypter(envPath) }));
      writeRawConfig(opts.configPath, raw);
      logger.info(`Job "${name}" criado via UI.`);

      const created = loadConfig(opts.configPath).find((j) => j.name === name)!;
      res.status(201).json(jobSummary(created));
    } catch (err) {
      sendError(res, err);
    }
  });

  // Testa a conexao (banco ou origem SFTP/FTP) com os dados atuais do formulario, sem salvar
  // nada. Usado pelo botao "Testar conexao" antes de liberar "Salvar" — nao roda nenhum dump/
  // download de verdade, so confirma que da pra conectar com essas credenciais.
  router.post("/jobs/test-connection", async (req, res) => {
    try {
      const body = req.body as JobInputBody;
      let existingJob: JobConfig | undefined;
      if (typeof body.existingJobName === "string" && body.existingJobName) {
        try {
          existingJob = loadConfig(opts.configPath).find((j) => j.name === body.existingJobName);
        } catch {
          // config com problema em outro job nao deve impedir de testar este aqui
        }
      }

      const target = buildConnectionTestTarget(body, existingJob);
      if (target.type === "files") await testFileSourceConnection(target.source);
      else await testDatabaseConnection(target.connection);

      res.json({ ok: true });
    } catch (err) {
      // Falha de conexao (host fora, senha errada) e resposta esperada do teste, nao erro do servidor.
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.put("/jobs/:name", (req, res) => {
    try {
      const raw = readRawConfig(opts.configPath);
      const idx = raw.jobs.findIndex((j) => j.name === req.params.name);
      if (idx === -1) {
        res.status(404).json({ error: `Job "${req.params.name}" nao encontrado.` });
        return;
      }

      const existing = raw.jobs[idx];
      const edited = buildRawJob(existing.name, req.body as JobInputBody, {
        existing,
        encryptPassword: passwordEncrypter(envPath),
      });
      raw.jobs[idx] = mergeEditedJob(existing, edited);
      writeRawConfig(opts.configPath, raw);
      logger.info(`Job "${existing.name}" atualizado via UI.`);

      const updated = loadConfig(opts.configPath).find((j) => j.name === existing.name)!;
      res.json(jobSummary(updated));
    } catch (err) {
      sendError(res, err);
    }
  });


  router.delete("/jobs/:name", (req, res) => {
    try {
      const raw = readRawConfig(opts.configPath);
      const idx = raw.jobs.findIndex((j) => j.name === req.params.name);
      if (idx === -1) {
        res.status(404).json({ error: `Job "${req.params.name}" nao encontrado.` });
        return;
      }
      raw.jobs.splice(idx, 1);
      writeRawConfig(opts.configPath, raw);
      logger.info(`Job "${req.params.name}" removido via UI (backups e logs existentes foram mantidos).`);
      res.status(204).end();
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  function setPaused(res: Response, jobName: string, paused: boolean): void {
    try {
      const raw = readRawConfig(opts.configPath);
      const job = raw.jobs.find((j) => j.name === jobName);
      if (!job) {
        res.status(404).json({ error: `Job "${jobName}" nao encontrado.` });
        return;
      }
      job.paused = paused;
      writeRawConfig(opts.configPath, raw);
      logger.info(`Job "${jobName}" ${paused ? "pausado" : "retomado"} via UI.`);
      const updated = loadConfig(opts.configPath).find((j) => j.name === jobName)!;
      res.json(jobSummary(updated));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  }

  router.post("/jobs/:name/pause", (req, res) => setPaused(res, req.params.name, true));
  router.post("/jobs/:name/resume", (req, res) => setPaused(res, req.params.name, false));

  router.get("/jobs/:name/backups", (req, res) => {
    const job = findJobOr404(req, res, opts);
    if (!job) return;
    res.json(
      listBackupFiles(job).map((f) => ({
        filename: f.filename,
        size: f.size,
        mtime: new Date(f.mtimeMs).toISOString(),
      })),
    );
  });

  router.get("/jobs/:name/backups/:filename/download", (req, res) => {
    const job = findJobOr404(req, res, opts);
    if (!job) return;
    const filePath = resolveBackupFile(job, req.params.filename);
    if (!filePath) {
      res.status(404).json({ error: "Arquivo de backup nao encontrado." });
      return;
    }
    res.download(filePath);
  });

  router.delete("/jobs/:name/backups/:filename", (req, res) => {
    const job = findJobOr404(req, res, opts);
    if (!job) return;
    const filePath = resolveBackupFile(job, req.params.filename);
    if (!filePath) {
      res.status(404).json({ error: "Arquivo de backup nao encontrado." });
      return;
    }
    fs.rmSync(filePath);
    logger.info(`Backup removido via UI: ${filePath}`);
    res.status(204).end();
  });

  router.get("/jobs/:name/log", (req, res) => {
    const job = findJobOr404(req, res, opts);
    if (!job) return;
    const logFile = path.join(opts.logDir, `${job.name}.log`);
    // Le so o fim do arquivo (nao o log inteiro) — readLastLines devolve [] se ainda nao existe.
    res.json({ lines: readLastLines(logFile, 200) });
  });

  router.post("/jobs/:name/run", (req, res) => {
    const job = findJobOr404(req, res, opts);
    if (!job) return;

    if (computeRunState(job).status === "running") {
      res.status(409).json({ error: "Job ja esta rodando." });
      return;
    }

    const startedAt = triggerJobRun(job, opts.logDir);
    res.status(202).json({ status: "running", startedAt });
  });

  // Pede pra interromper o run em andamento. Funciona cross-process (o run pode estar num
  // "isbackup run" disparado pelo cron): so grava o arquivo de cancelamento, e quem esta rodando
  // o job o detecta e aborta sozinho. Responde 202 porque a parada nao e instantanea.
  router.post("/jobs/:name/stop", (req, res) => {
    const job = findJobOr404(req, res, opts);
    if (!job) return;

    if (computeRunState(job).status !== "running") {
      res.status(409).json({ error: "Job nao esta rodando." });
      return;
    }

    requestCancel(job);
    logger.info(`Parada do job "${job.name}" solicitada via UI.`);
    res.status(202).json({ status: "stopping" });
  });

  // Previa ao vivo pro formulario de criar/editar job: dado um schedule (ainda nao salvo,
  // pode nem pertencer a um job existente) e uma retencao, projeta runs/dia e arquivos retidos.
  router.post("/schedule/preview", (req, res) => {
    try {
      const schedule = String(req.body?.schedule ?? "").trim();
      if (!schedule) {
        res.status(400).json({ error: 'Campo "schedule" e obrigatorio.' });
        return;
      }
      const resolvedSchedule = resolveSchedule(schedule);
      const retentionDays = Number(req.body?.retentionDays);

      res.json({
        resolvedSchedule,
        runsPerDay: estimateRunsPerDay(resolvedSchedule),
        estimatedRetainedCount: Number.isFinite(retentionDays)
          ? estimateRetainedCount(resolvedSchedule, retentionDays)
          : null,
      });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // ----- Ajustes: onde guardar os backups -----------------------------------------------------
  function settingsSummary() {
    const raw = readRawConfig(opts.configPath);
    const backupDir = currentBackupDir(raw, opts.configPath);
    return {
      backupDir,
      /** Como aparece no computador do usuario (no Docker, a pasta do host; null se nao mapeavel). */
      backupDirOnHost: hostPathFor(backupDir),
      freeBytes: freeBytes(backupDir),
      docker: isDocker(),
      /** Jobs com pasta propria no config.yaml: nao seguem a pasta padrao. */
      jobsWithOwnDir: raw.jobs.filter((j) => j.outputDir).map((j) => j.name),
      suggestions: isDocker() ? [] : suggestedDirs(),
      move: getMoveStatus(),
    };
  }

  router.get("/settings", (_req, res) => {
    try {
      res.json(settingsSummary());
    } catch (err) {
      sendError(res, err);
    }
  });

  router.put("/settings", (req, res) => {
    try {
      if (isDocker()) {
        throw new SettingsError(
          "No Docker, a pasta dos dados e escolhida ao subir o container: rode ./docker.sh setup no seu computador.",
        );
      }
      const raw = readRawConfig(opts.configPath);
      const oldDir = currentBackupDir(raw, opts.configPath);
      const newDir = normalizeUserPath(String(req.body?.backupDir ?? ""));
      const moveExisting = req.body?.moveExisting === true;

      if (newDir === oldDir) {
        res.json(settingsSummary());
        return;
      }
      if (newDir.startsWith(oldDir + path.sep) || oldDir.startsWith(newDir + path.sep)) {
        throw new SettingsError("A pasta nova nao pode ficar dentro da atual (nem a atual dentro da nova).");
      }

      const jobs = loadConfig(opts.configPath);
      if (moveExisting && jobs.some((j) => readRunLock(j))) {
        res.status(409).json({ error: "Tem backup rodando agora. Espere terminar para mover os arquivos." });
        return;
      }
      ensureWritableDir(newDir);

      raw.defaults = { ...raw.defaults, outputDir: newDir };
      writeRawConfig(opts.configPath, raw);
      logger.info(`Pasta dos backups alterada via UI: ${oldDir} -> ${newDir}`);

      // So os jobs que seguem a pasta padrao (sem outputDir proprio) mudam de lugar.
      const moving =
        moveExisting && startMovingBackups(oldDir, newDir, raw.jobs.filter((j) => !j.outputDir).map((j) => j.name));
      res.status(moving ? 202 : 200).json(settingsSummary());
    } catch (err) {
      if (err instanceof SettingsError) res.status(400).json({ error: err.message });
      else sendError(res, err);
    }
  });

  router.get("/cron/status", (_req, res) => {
    const lines = extractManagedBlock(readCurrentCrontab());

    // Compara as linhas de fato instaladas com as que o config atual geraria — nao so os nomes
    // dos jobs. Comparar so os nomes deixava passar batido um job cujo *schedule* (ou saida, ou
    // retencao via cron) mudou na UI mas cujo crontab nunca foi reinstalado: o card aparecia
    // "atrasado" porque a saude e calculada contra o schedule novo, mas o cron continuava rodando
    // no horario antigo.
    let expectedLines: string[] = [];
    try {
      const activeJobs = loadConfig(opts.configPath).filter((j) => !j.paused);
      expectedLines = activeJobs.length ? extractManagedBlock(buildManagedBlock(activeJobs, cronCtx())) : [];
    } catch {
      // config invalido nao deve impedir a leitura do status do cron
    }

    const stale =
      lines.length > 0 &&
      (lines.length !== expectedLines.length || !lines.every((line) => expectedLines.includes(line)));

    res.json({ installed: lines.length > 0, lines, stale });
  });

  router.post("/cron/install", (_req, res) => {
    try {
      const jobs = loadConfig(opts.configPath);
      if (jobs.length === 0) {
        res.status(400).json({ error: "Nenhum job configurado." });
        return;
      }
      const ctx = cronCtx();
      fs.mkdirSync(ctx.logDir, { recursive: true });
      applyCrontab(buildNewCrontab(jobs, ctx));
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.post("/cron/uninstall", (_req, res) => {
    try {
      applyCrontab(buildNewCrontab([], cronCtx()));
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  return router;
}

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
import type { JobConfig, JobType, FileProtocol, RawFileSourceConfig, RawJobConfig } from "../types.js";
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

export interface ApiOptions {
  configPath: string;
  projectRoot: string;
  logDir: string;
}

export interface SizeTrend {
  /** "ok": ultimo backup maior que o anterior. "warning": igual ou menor (indicio de falha silenciosa). "unknown": sem base de comparacao (0 ou 1 backup ainda). */
  status: "ok" | "warning" | "unknown";
  lastSize: number;
  previousSize: number | null;
}

/**
 * Compara o tamanho do ultimo backup com o penultimo. Um backup bem-sucedido deve, na pratica,
 * ser sempre igual ou maior que o anterior (o banco so cresce); um arquivo igual ou menor e um
 * sinal de que o dump pode ter falhado silenciosamente (conexao caiu no meio, disco cheio, etc).
 */
function computeSizeTrend(files: { size: number }[]): SizeTrend {
  const last = files[0];
  const previous = files[1];
  if (!last || !previous) {
    return { status: "unknown", lastSize: last ? last.size : 0, previousSize: null };
  }
  return {
    status: last.size > previous.size ? "ok" : "warning",
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

const JOB_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

interface JobInputBody {
  name?: unknown;
  type?: unknown;
  host?: unknown;
  port?: unknown;
  user?: unknown;
  password?: unknown;
  databases?: unknown;
  schedule?: unknown;
  retentionDays?: unknown;
  gzip?: unknown;
  fileSourceProtocol?: unknown;
  fileSourceHost?: unknown;
  fileSourcePort?: unknown;
  fileSourceUser?: unknown;
  fileSourcePassword?: unknown;
  fileSourceRemoteDir?: unknown;
  fileSourcePattern?: unknown;
  fileSourceNameContains?: unknown;
  fileSourceModifiedWithinDays?: unknown;
  fileSourceSecure?: unknown;
}

function parseDatabasesInput(value: unknown): "all" | string[] {
  if (value === "all" || value === undefined || value === null || value === "") return "all";
  const items = typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : null;
  if (items === null) throw new Error('Campo "databases" invalido.');
  const parsed = items.map((s) => String(s).trim()).filter(Boolean);
  return parsed.length > 0 ? parsed : "all";
}

function parsePort(value: unknown): number {
  const n = Number(value === "" || value === undefined || value === null ? 3306 : value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`Porta invalida: "${value}".`);
  return n;
}

function parseRetentionDays(value: unknown): number {
  const n = Number(value === "" || value === undefined || value === null ? 7 : value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`Retencao invalida: "${value}".`);
  return n;
}

function requireNonEmpty(value: unknown, field: string): string {
  const s = String(value ?? "").trim();
  if (!s) throw new Error(`Campo "${field}" e obrigatorio.`);
  return s;
}

/** Cifra a senha com a chave mestre (.env), pra gravar direto no config.yaml. */
function encryptPassword(envPath: string, password: string): string {
  const key = getOrCreateEncryptionKey(envPath);
  return encrypt(password, key);
}

function requireJobType(value: unknown): JobType {
  return value === "files" ? "files" : "database";
}

function parseFileSourcePort(protocol: FileProtocol, value: unknown): number {
  const fallback = protocol === "sftp" ? 22 : 21;
  const n = Number(value === "" || value === undefined || value === null ? fallback : value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`Porta de origem invalida: "${value}".`);
  return n;
}

function parseModifiedWithinDays(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error('Campo "modificados nos ultimos N dias" deve ser um numero positivo.');
  }
  return n;
}

/**
 * Monta o bloco fileSource a partir do body do form, no mesmo padrao ja usado pra senha do job:
 * obrigatoria na criacao, opcional na edicao (vazia = mantem a senha remota atual).
 */
function buildFileSourceInput(
  body: JobInputBody,
  envPath: string,
  existing: RawFileSourceConfig | undefined,
): RawFileSourceConfig {
  const protocol: FileProtocol = body.fileSourceProtocol === "ftp" ? "ftp" : "sftp";
  const host = requireNonEmpty(body.fileSourceHost, "fileSource.host");
  const user = requireNonEmpty(body.fileSourceUser, "fileSource.user");

  const newPassword = String(body.fileSourcePassword ?? "");
  if (!newPassword && !existing?.password) {
    throw new Error('Campo "fileSource.password" e obrigatorio.');
  }
  const password = newPassword ? encryptPassword(envPath, newPassword) : existing!.password!;

  return {
    protocol,
    host,
    port: parseFileSourcePort(protocol, body.fileSourcePort),
    user,
    password,
    remoteDir: String(body.fileSourceRemoteDir ?? "").trim() || "/",
    pattern: String(body.fileSourcePattern ?? "").trim() || "*",
    nameContains: String(body.fileSourceNameContains ?? "").trim() || undefined,
    modifiedWithinDays: parseModifiedWithinDays(body.fileSourceModifiedWithinDays),
    secure: Boolean(body.fileSourceSecure),
  };
}

export function createApiRouter(opts: ApiOptions): Router {
  const router = Router();

  const cronCtx = (): CronContext => ({
    projectRoot: opts.projectRoot,
    configPath: path.resolve(opts.configPath),
    logDir: opts.logDir,
  });

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
      const name = requireNonEmpty(body.name, "name");
      if (!JOB_NAME_PATTERN.test(name)) {
        throw new Error('Nome invalido: use apenas letras, numeros, "-" e "_", sem espacos.');
      }

      const raw = readRawConfig(opts.configPath);
      if (raw.jobs.some((j) => j.name === name)) {
        res.status(409).json({ error: `Ja existe um job chamado "${name}".` });
        return;
      }

      const schedule = requireNonEmpty(body.schedule, "schedule");
      resolveSchedule(schedule);
      const envPath = path.join(opts.projectRoot, ".env");
      const type = requireJobType(body.type);

      let newJob: RawJobConfig;
      if (type === "files") {
        newJob = {
          name,
          type: "files",
          schedule,
          retentionDays: parseRetentionDays(body.retentionDays),
          fileSource: buildFileSourceInput(body, envPath, undefined),
        };
      } else {
        const user = requireNonEmpty(body.user, "user");
        const password = requireNonEmpty(body.password, "password");
        newJob = {
          name,
          type: "database",
          host: String(body.host ?? "").trim() || undefined,
          port: parsePort(body.port),
          user,
          password: encryptPassword(envPath, password),
          databases: parseDatabasesInput(body.databases),
          schedule,
          retentionDays: parseRetentionDays(body.retentionDays),
          gzip: typeof body.gzip === "boolean" ? body.gzip : true,
        };
      }

      raw.jobs.push(newJob);
      writeRawConfig(opts.configPath, raw);
      logger.info(`Job "${name}" criado via UI.`);

      const created = loadConfig(opts.configPath).find((j) => j.name === name)!;
      res.status(201).json(jobSummary(created));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Testa a conexao (banco ou origem SFTP/FTP) com os dados atuais do formulario, sem salvar
  // nada. Usado pelo botao "Testar conexao" antes de liberar "Salvar" — nao roda nenhum dump/
  // download de verdade, so confirma que da pra conectar com essas credenciais.
  router.post("/jobs/test-connection", async (req, res) => {
    try {
      const body = req.body as JobInputBody & { existingJobName?: unknown };
      const type = requireJobType(body.type);
      const existingJobName = typeof body.existingJobName === "string" ? body.existingJobName : undefined;

      let existingJob: JobConfig | undefined;
      if (existingJobName) {
        try {
          existingJob = loadConfig(opts.configPath).find((j) => j.name === existingJobName);
        } catch {
          // config com problema em outro job nao deve impedir de testar este aqui
        }
      }

      if (type === "files") {
        const protocol: FileProtocol = body.fileSourceProtocol === "ftp" ? "ftp" : "sftp";
        const host = requireNonEmpty(body.fileSourceHost, "fileSource.host");
        const user = requireNonEmpty(body.fileSourceUser, "fileSource.user");
        const typedPassword = String(body.fileSourcePassword ?? "");
        const fallbackPassword = existingJob?.type === "files" ? existingJob.fileSource.password : "";
        const password = typedPassword || fallbackPassword;
        if (!password) {
          res.status(400).json({ error: "Informe a senha para testar a conexao." });
          return;
        }
        await testFileSourceConnection({
          protocol,
          host,
          port: parseFileSourcePort(protocol, body.fileSourcePort),
          user,
          password,
          remoteDir: String(body.fileSourceRemoteDir ?? "").trim() || "/",
          pattern: "*",
          nameContains: null,
          modifiedWithinDays: null,
          secure: Boolean(body.fileSourceSecure),
        });
      } else {
        const host = String(body.host ?? "").trim() || "localhost";
        const user = requireNonEmpty(body.user, "user");
        const typedPassword = String(body.password ?? "");
        const fallbackPassword = existingJob?.type === "database" ? existingJob.password : "";
        const password = typedPassword || fallbackPassword;
        if (!password) {
          res.status(400).json({ error: "Informe a senha para testar a conexao." });
          return;
        }
        await testDatabaseConnection({ host, port: parsePort(body.port), user, password });
      }

      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.put("/jobs/:name", (req, res) => {
    try {
      const body = req.body as JobInputBody;
      const raw = readRawConfig(opts.configPath);
      const existing = raw.jobs.find((j) => j.name === req.params.name);
      if (!existing) {
        res.status(404).json({ error: `Job "${req.params.name}" nao encontrado.` });
        return;
      }

      const wasType: JobType = existing.type === "files" ? "files" : "database";
      const previousFileSource = existing.fileSource;
      const previousPassword = existing.password;

      const schedule = requireNonEmpty(body.schedule, "schedule");
      resolveSchedule(schedule);
      const envPath = path.join(opts.projectRoot, ".env");
      const type = requireJobType(body.type);

      existing.type = type;
      existing.schedule = schedule;
      existing.retentionDays = parseRetentionDays(body.retentionDays);

      if (type === "files") {
        existing.fileSource = buildFileSourceInput(body, envPath, wasType === "files" ? previousFileSource : undefined);
        // Job trocou de tipo (ou foi criado direto como "files") — limpa os campos de banco pra
        // nao deixar lixo de um tipo anterior no config.yaml.
        delete existing.host;
        delete existing.port;
        delete existing.user;
        delete existing.password;
        delete existing.databases;
        delete existing.gzip;
      } else {
        const user = requireNonEmpty(body.user, "user");
        const newPassword = String(body.password ?? "");
        if (newPassword) {
          existing.password = encryptPassword(envPath, newPassword);
        } else if (wasType === "database" && previousPassword) {
          existing.password = previousPassword; // mantem a senha atual, igual ao comportamento de hoje
        } else {
          throw new Error('Campo "password" e obrigatorio.');
        }
        existing.host = String(body.host ?? "").trim() || undefined;
        existing.port = parsePort(body.port);
        existing.user = user;
        existing.databases = parseDatabasesInput(body.databases);
        existing.gzip = typeof body.gzip === "boolean" ? body.gzip : true;
        delete existing.fileSource;
      }

      writeRawConfig(opts.configPath, raw);
      logger.info(`Job "${existing.name}" atualizado via UI.`);

      const updated = loadConfig(opts.configPath).find((j) => j.name === existing.name)!;
      res.json(jobSummary(updated));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
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
    if (!fs.existsSync(logFile)) {
      res.json({ lines: [] });
      return;
    }
    const lines = fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean).slice(-200);
    res.json({ lines });
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

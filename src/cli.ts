#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import dotenv from "dotenv";
import { loadConfig } from "./config.js";
import { runJobBackup } from "./backup-runner.js";
import { logger } from "./logger.js";
import {
  buildNewCrontab,
  applyCrontab,
  readCurrentCrontab,
  extractManagedBlock,
  resolveSchedule,
  type CronContext,
} from "./cron.js";
import type { JobConfig } from "./types.js";
import { createApp } from "./web/server.js";
import { startCatchUpScheduler } from "./web/catchup.js";
import { getOrCreateEncryptionKey } from "./env-writer.js";
import { encrypt } from "./crypto.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.dirname(__dirname);
const DEFAULT_CONFIG_PATH = path.join(projectRoot, "config.yaml");
const DEFAULT_LOG_DIR = path.join(projectRoot, "logs");

dotenv.config({ path: path.join(projectRoot, ".env"), quiet: true });

const program = new Command();
program
  .name("isbackup")
  .description("Backup (dump) de bancos MySQL/MariaDB configurado por arquivo, com rotinas via cron");

function withConfigOption(cmd: Command): Command {
  return cmd.option("-c, --config <path>", "caminho do arquivo de configuracao", DEFAULT_CONFIG_PATH);
}

function findJob(jobs: JobConfig[], name: string): JobConfig {
  const job = jobs.find((j) => j.name === name);
  if (!job) {
    const available = jobs.map((j) => j.name).join(", ") || "(nenhum)";
    throw new Error(`Job "${name}" nao encontrado. Jobs disponiveis: ${available}`);
  }
  return job;
}

program
  .command("init")
  .description("Cria config.yaml e .env de exemplo no diretorio do projeto")
  .action(() => {
    const envTarget = path.join(projectRoot, ".env");

    if (fs.existsSync(DEFAULT_CONFIG_PATH)) {
      logger.warn(`${DEFAULT_CONFIG_PATH} ja existe, nada foi alterado.`);
    } else {
      fs.copyFileSync(path.join(projectRoot, "config.example.yaml"), DEFAULT_CONFIG_PATH);
      logger.info(`Criado ${DEFAULT_CONFIG_PATH}`);
    }

    if (fs.existsSync(envTarget)) {
      logger.warn(`${envTarget} ja existe, nada foi alterado.`);
    } else {
      fs.copyFileSync(path.join(projectRoot, ".env.example"), envTarget);
      logger.info(`Criado ${envTarget}`);
    }

    logger.info('Edite os dois arquivos com seus dados e rode "isbackup list" para conferir.');
  });

program
  .command("encrypt <valor>")
  .description('Cifra um valor (ex: senha) para colar no config.yaml como password: "enc:v1:...."')
  .action((valor: string) => {
    const envPath = path.join(projectRoot, ".env");
    const key = getOrCreateEncryptionKey(envPath);
    console.log(encrypt(valor, key));
  });

withConfigOption(program.command("list"))
  .description("Lista os jobs configurados")
  .action((opts: { config: string }) => {
    const jobs = loadConfig(opts.config);
    const rows = jobs.map((job) => ({
      job: job.name,
      tipo: job.type === "files" ? "arquivos" : "banco",
      origem:
        job.type === "files"
          ? `${job.fileSource.protocol}://${job.fileSource.host}:${job.fileSource.port}${job.fileSource.remoteDir}`
          : `${job.host}:${job.port}`,
      usuario: job.type === "files" ? job.fileSource.user : job.user,
      detalhe:
        job.type === "files"
          ? `padrao "${job.fileSource.pattern}"`
          : job.databases === "all"
            ? "todos os bancos"
            : job.databases.join(","),
      schedule: `${job.schedule} -> ${resolveSchedule(job.schedule)}`,
      saida: job.outputDir,
      retencao: `${job.retentionDays}d`,
    }));
    console.table(rows);
  });

withConfigOption(program.command("run [jobName]"))
  .description("Executa o dump de um job (ou de todos, com --all)")
  .option("--all", "executa todos os jobs configurados")
  .option("--dry-run", "mostra o que seria executado, sem rodar o mysqldump")
  .action(async (jobName: string | undefined, opts: { config: string; all?: boolean; dryRun?: boolean }) => {
    const jobs = loadConfig(opts.config);

    if (!opts.all && !jobName) {
      throw new Error('Informe o nome de um job ou use --all. Veja "isbackup list".');
    }

    const targets = opts.all ? jobs : [findJob(jobs, jobName as string)];
    let failures = 0;

    for (const job of targets) {
      try {
        await runJobBackup(job, { dryRun: opts.dryRun, logDir: DEFAULT_LOG_DIR });
      } catch (err) {
        failures += 1;
        logger.error(`Job "${job.name}" falhou: ${(err as Error).message}`);
      }
    }

    if (failures > 0) {
      process.exitCode = 1;
    }
  });

const cron = program.command("cron").description("Gerencia a instalacao das rotinas no crontab do usuario");

withConfigOption(cron.command("install"))
  .description("Escreve/atualiza as entradas do crontab com base no schedule de cada job")
  .option("--dry-run", "mostra o crontab resultante sem aplicar")
  .action((opts: { config: string; dryRun?: boolean }) => {
    const jobs = loadConfig(opts.config);
    if (jobs.length === 0) {
      logger.warn("Nenhum job configurado, nada a instalar.");
      return;
    }

    const ctx: CronContext = {
      projectRoot,
      configPath: path.resolve(opts.config),
      logDir: DEFAULT_LOG_DIR,
    };
    const newCrontab = buildNewCrontab(jobs, ctx);

    if (opts.dryRun) {
      console.log(newCrontab);
      logger.info("[dry-run] crontab acima NAO foi aplicado. Rode sem --dry-run para instalar.");
      return;
    }

    fs.mkdirSync(ctx.logDir, { recursive: true });
    applyCrontab(newCrontab);
    logger.info(`Crontab atualizado com ${jobs.length} job(s). Logs em ${ctx.logDir}`);
  });

cron
  .command("uninstall")
  .description("Remove as entradas gerenciadas pelo isbackup do crontab")
  .option("--dry-run", "mostra o crontab resultante sem aplicar")
  .action((opts: { dryRun?: boolean }) => {
    const ctx: CronContext = { projectRoot, configPath: DEFAULT_CONFIG_PATH, logDir: DEFAULT_LOG_DIR };
    const newCrontab = buildNewCrontab([], ctx);

    if (opts.dryRun) {
      console.log(newCrontab || "(crontab ficaria vazio)");
      logger.info("[dry-run] nada foi aplicado.");
      return;
    }

    applyCrontab(newCrontab);
    logger.info("Entradas do isbackup removidas do crontab.");
  });

cron
  .command("status")
  .description("Mostra as entradas atualmente instaladas no crontab")
  .action(() => {
    const current = readCurrentCrontab();
    const lines = extractManagedBlock(current);
    if (lines.length === 0) {
      logger.info("Nenhum job do isbackup instalado no crontab.");
      return;
    }
    for (const line of lines) console.log(line);
  });

withConfigOption(program.command("ui"))
  .description("Sobe a interface web local (127.0.0.1 apenas) para ver e gerenciar os backups")
  .option("-p, --port <port>", "porta local", "8787")
  .action((opts: { config: string; port: string }) => {
    const port = Number(opts.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error(`Porta invalida: ${opts.port}`);
    }

    const app = createApp({ configPath: opts.config, projectRoot, logDir: DEFAULT_LOG_DIR });
    app.listen(port, "127.0.0.1", () => {
      logger.info(`Interface web em http://127.0.0.1:${port} (sem login, acesso somente local)`);
    });

    // Rede de seguranca: enquanto a UI estiver de pe, cobre o caso do cron ter pulado um
    // horario porque a maquina estava dormindo (ver README).
    startCatchUpScheduler({ configPath: opts.config, logDir: DEFAULT_LOG_DIR });
  });

program.parseAsync(process.argv).catch((err: Error) => {
  logger.error(err.message);
  process.exitCode = 1;
});

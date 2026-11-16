#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Command } from "commander";
import dotenv from "dotenv";
import { loadConfig } from "./config.js";
import { runJobBackup } from "./backup-runner.js";
import { RunAlreadyActiveError } from "./run-lock.js";
import { logger } from "./logger.js";
import { resolveSchedule, type CronContext } from "./cron.js";
import { getScheduler } from "./scheduler.js";
import { isDueAt } from "./schedule-status.js";
import type { JobConfig } from "./types.js";
import { createApp } from "./web/server.js";
import { startCatchUpScheduler } from "./web/catchup.js";
import { getOrCreateEncryptionKey, restrictToOwner } from "./env-writer.js";
import { encrypt } from "./crypto.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.dirname(__dirname);
// Pasta dos dados (config.yaml, .env, logs/ e, por padrao, backups/). Normalmente e a propria
// pasta do projeto; ISBACKUP_HOME permite separar codigo e dados — e o que a imagem Docker usa,
// com os dados num volume em /data.
const dataDir = process.env.ISBACKUP_HOME ? path.resolve(process.env.ISBACKUP_HOME) : projectRoot;
const DEFAULT_CONFIG_PATH = path.join(dataDir, "config.yaml");
const DEFAULT_LOG_DIR = path.join(dataDir, "logs");
const ENV_PATH = path.join(dataDir, ".env");

dotenv.config({ path: ENV_PATH, quiet: true });
// Corrige a permissao de um .env criado antes (ou a mao) com 644.
restrictToOwner(ENV_PATH);

const program = new Command();
program
  .name("isbackup")
  .description("Backup (dump) de bancos MySQL/MariaDB configurado por arquivo, com rotinas via cron");

function withConfigOption(cmd: Command): Command {
  return cmd.option("-c, --config <path>", "caminho do arquivo de configuracao", DEFAULT_CONFIG_PATH);
}

/**
 * Abre a URL no navegador padrao (macOS: open; Linux: xdg-open; Windows: start). Melhor esforco:
 * se nao houver navegador/ambiente grafico (servidor, container, SSH), so registra a URL.
 */
function openInBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => logger.info(`Abra no navegador: ${url}`));
    child.unref();
  } catch {
    logger.info(`Abra no navegador: ${url}`);
  }
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
  .description("Cria config.yaml e .env de exemplo na pasta de dados")
  .action(() => {
    const envTarget = ENV_PATH;
    fs.mkdirSync(dataDir, { recursive: true });

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
    const key = getOrCreateEncryptionKey(ENV_PATH);
    console.log(encrypt(valor, key));
  });

withConfigOption(program.command("list"))
  .description("Lista os jobs configurados")
  .action((opts: { config: string }) => {
    const jobs = loadConfig(opts.config);
    if (jobs.length === 0) {
      logger.info(`Nenhum job em ${opts.config}. Crie um pela interface ("isbackup ui") ou edite o arquivo.`);
      return;
    }
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
        if (err instanceof RunAlreadyActiveError) {
          logger.warn(err.message); // outro processo ja esta fazendo esse backup — nao e falha
          continue;
        }
        failures += 1;
        logger.error(`Job "${job.name}" falhou: ${(err as Error).message}`);
      }
    }

    if (failures > 0) {
      process.exitCode = 1;
    }
  });

// "cron" por historico: em macOS/Linux e o crontab; no Windows, o Agendador de Tarefas (scheduler.ts).
const scheduler = getScheduler();
const cron = program
  .command("cron")
  .description(`Gerencia o agendamento das rotinas (neste sistema: ${scheduler.name})`);

function schedulerCtx(configPath: string): CronContext {
  return { projectRoot, configPath: path.resolve(configPath), logDir: DEFAULT_LOG_DIR };
}

withConfigOption(cron.command("install"))
  .description("Instala/atualiza o agendamento com base na rotina de cada job")
  .option("--dry-run", "mostra o que seria instalado, sem aplicar")
  .action((opts: { config: string; dryRun?: boolean }) => {
    const jobs = loadConfig(opts.config);
    if (jobs.length === 0) {
      logger.warn("Nenhum job configurado, nada a instalar.");
      return;
    }
    const ctx = schedulerCtx(opts.config);

    if (opts.dryRun) {
      console.log(scheduler.preview(jobs, ctx));
      logger.info(`[dry-run] nada foi aplicado no ${scheduler.name}. Rode sem --dry-run para instalar.`);
      return;
    }

    fs.mkdirSync(ctx.logDir, { recursive: true });
    scheduler.install(jobs, ctx);
    logger.info(`${scheduler.name} atualizado com ${jobs.filter((j) => !j.paused).length} job(s). Logs em ${ctx.logDir}`);
  });

withConfigOption(cron.command("uninstall"))
  .description("Remove o agendamento das rotinas do isbackup")
  .option("--dry-run", "mostra o resultado sem aplicar")
  .action((opts: { config: string; dryRun?: boolean }) => {
    const ctx = schedulerCtx(opts.config);
    if (opts.dryRun) {
      console.log(scheduler.preview([], ctx) || "(nada ficaria agendado)");
      logger.info("[dry-run] nada foi aplicado.");
      return;
    }
    scheduler.uninstall(ctx);
    logger.info(`Rotinas do isbackup removidas do ${scheduler.name}.`);
  });

withConfigOption(cron.command("status"))
  .description("Mostra o que esta agendado agora")
  .action((opts: { config: string }) => {
    let jobs: JobConfig[] | null = null;
    try {
      jobs = loadConfig(opts.config);
    } catch {
      // config invalido: mostra o status mesmo assim
    }
    const status = scheduler.status(jobs, schedulerCtx(opts.config));
    if (!status.installed) {
      logger.info(`Nenhuma rotina do isbackup instalada no ${status.name}.`);
      return;
    }
    for (const line of status.lines) console.log(line);
    if (status.stale) logger.warn(`O ${status.name} esta desatualizado: rode "isbackup cron install".`);
  });

// Chamado pelo Agendador do Windows a cada minuto (ver scheduler.ts). Funciona em qualquer sistema.
withConfigOption(program.command("tick"))
  .description("Roda os jobs ativos cujo horario e agora (usado pelo Agendador do Windows a cada minuto)")
  .option("--dry-run", "mostra quais jobs rodariam, sem executar")
  .action(async (opts: { config: string; dryRun?: boolean }) => {
    const now = new Date();
    const due = loadConfig(opts.config).filter((j) => !j.paused && isDueAt(resolveSchedule(j.schedule), now));
    const results = await Promise.allSettled(
      due.map((job) => runJobBackup(job, { dryRun: opts.dryRun, logDir: DEFAULT_LOG_DIR })),
    );
    let failures = 0;
    results.forEach((r, i) => {
      if (r.status === "fulfilled") return;
      if (r.reason instanceof RunAlreadyActiveError) {
        logger.warn((r.reason as Error).message);
        return;
      }
      failures += 1;
      logger.error(`Job "${due[i].name}" falhou: ${(r.reason as Error).message}`);
    });
    if (failures > 0) process.exitCode = 1;
  });

withConfigOption(program.command("ui"))
  .description("Sobe a interface web local para ver e gerenciar os backups")
  .option("-p, --port <port>", "porta local", "8787")
  .option(
    "--host <host>",
    "endereco em que o servidor escuta. Padrao: so esta maquina. Use 0.0.0.0 apenas dentro de um container (com a porta publicada so em 127.0.0.1 do host)",
    "127.0.0.1",
  )
  .option("--open", "abre o painel no navegador assim que o servidor estiver no ar")
  .action((opts: { config: string; port: string; host: string; open?: boolean }) => {
    const port = Number(opts.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error(`Porta invalida: ${opts.port}`);
    }

    const app = createApp({ configPath: opts.config, projectRoot, logDir: DEFAULT_LOG_DIR, envPath: ENV_PATH });
    const server = app.listen(port, opts.host, () => {
      const shown = opts.host === "0.0.0.0" ? "127.0.0.1" : opts.host;
      const url = `http://${shown}:${port}`;
      logger.info(`Interface web em ${url} (sem login: nao exponha essa porta na rede)`);
      if (opts.open) openInBrowser(url);
    });
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        logger.error(
          `A porta ${port} ja esta em uso (o isbackup ja esta aberto em outra janela?). ` +
            `Feche a outra instancia ou use outra porta: --port ${port + 1}`,
        );
      } else {
        logger.error(`Nao foi possivel iniciar o painel: ${err.message}`);
      }
      process.exit(1);
    });

    // Rede de seguranca: enquanto a UI estiver de pe, cobre o caso do cron ter pulado um
    // horario porque a maquina estava dormindo (ver README).
    startCatchUpScheduler({ configPath: opts.config, logDir: DEFAULT_LOG_DIR });
  });

program.parseAsync(process.argv).catch((err: Error) => {
  logger.error(err.message);
  process.exitCode = 1;
});

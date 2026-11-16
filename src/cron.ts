import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { JobConfig } from "./types.js";

export const SCHEDULE_PRESETS: Record<string, string> = {
  hourly: "0 * * * *",
  daily: "0 3 * * *",
  weekly: "0 3 * * 0",
  monthly: "0 3 1 * *",
};

const CRON_FIELD_PATTERN = /^[0-9*/,-]+$/;

/** Aceita um preset ("daily", "weekly", ...) ou uma expressao cron de 5 campos. */
export function resolveSchedule(schedule: string): string {
  const preset = SCHEDULE_PRESETS[schedule.trim().toLowerCase()];
  if (preset) return preset;

  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5 || !fields.every((f) => CRON_FIELD_PATTERN.test(f))) {
    throw new Error(
      `Schedule invalido: "${schedule}". Use um preset (${Object.keys(SCHEDULE_PRESETS).join(", ")}) ` +
        `ou uma expressao cron de 5 campos, ex: "0 3 * * *".`,
    );
  }
  return fields.join(" ");
}

const BLOCK_START = "# >>> isbackup managed jobs (gerado automaticamente, nao editar a mao) >>>";
const BLOCK_END = "# <<< isbackup managed jobs <<<";

export interface CronContext {
  projectRoot: string;
  configPath: string;
  logDir: string;
}

// Links estaveis que gerenciadores de pacote mantem apontando pra versao atual do node.
const STABLE_NODE_LINKS = ["/opt/homebrew/bin/node", "/usr/local/bin/node"];

/**
 * Caminho do node pra gravar no crontab. process.execPath vem resolvido pro diretorio versionado
 * do Homebrew (ex: /opt/homebrew/Cellar/node/26.5.0/bin/node), que some no proximo
 * `brew upgrade node` — e todos os backups do cron passariam a falhar sem nenhum aviso. Se houver
 * um link estavel apontando pro mesmo binario, usa ele no lugar.
 */
export function stableNodePath(execPath: string = process.execPath): string {
  let realExec: string;
  try {
    realExec = fs.realpathSync(execPath);
  } catch {
    return execPath;
  }
  for (const link of STABLE_NODE_LINKS) {
    try {
      if (link !== execPath && fs.realpathSync(link) === realExec) return link;
    } catch {
      // link nao existe nesta maquina
    }
  }
  return execPath;
}

/**
 * Argumento seguro pra linha de comando do crontab. Caminhos "comuns" ficam como estao (a linha
 * continua legivel e igual a de antes); qualquer outro caractere (espaco, aspas, ";"...) vai entre
 * aspas simples. "%" precisa de "\" em qualquer lugar: no crontab ele vira quebra de linha.
 */
export function cronShellArg(value: string): string {
  if (/^[A-Za-z0-9_\/.:=@+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`.replace(/%/g, "\\%");
}

function jobCronLine(job: JobConfig, ctx: CronContext): string {
  const cronExpr = resolveSchedule(job.schedule);
  // O cron so existe em macOS/Linux: caminhos sempre no formato posix.
  const cliPath = path.posix.join(ctx.projectRoot, "dist", "cli.js");
  // Sem redirecionamento de log aqui: o proprio "isbackup run" ja grava em logs/<job>.log
  // diretamente (job-log.ts), do mesmo jeito que um run disparado pela UI ou pelo self-heal —
  // redirecionar o shell tambem pro mesmo arquivo duplicaria cada linha.
  let command = [stableNodePath(), cliPath, "run", job.name, "--config", ctx.configPath].map(cronShellArg).join(" ");
  // O cron roda os comandos com um ambiente minimo: se a pasta de dados foi definida por
  // ISBACKUP_HOME (ex: na imagem Docker), ela precisa ir junto na linha, senao o job procuraria o
  // .env (chave das senhas) e os logs na pasta do codigo.
  const dataHome = process.env.ISBACKUP_HOME;
  if (dataHome) command = `ISBACKUP_HOME=${cronShellArg(path.resolve(dataHome))} ${command}`;
  return `${cronExpr} ${command} # isbackup:${job.name}`;
}

export function buildManagedBlock(jobs: JobConfig[], ctx: CronContext): string {
  const lines = jobs.map((job) => jobCronLine(job, ctx));
  return [BLOCK_START, ...lines, BLOCK_END].join("\n");
}

const CRONTAB_MISSING =
  "Comando \"crontab\" nao encontrado. Instale o cron (Debian/Ubuntu: sudo apt install cron; " +
  "Fedora: sudo dnf install cronie; Arch: sudo pacman -S cronie) e confira se o servico esta ativo.";

export function readCurrentCrontab(): string {
  const result = spawnSync("crontab", ["-l"], { encoding: "utf8" });
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(CRONTAB_MISSING);
    throw result.error;
  }
  if (result.status !== 0) {
    // "no crontab for <user>" sai com codigo != 0 na primeira vez; tratamos como vazio.
    return "";
  }
  return result.stdout;
}

export function stripManagedBlock(text: string): string {
  const startIdx = text.indexOf(BLOCK_START);
  const endIdx = text.indexOf(BLOCK_END);
  if (startIdx === -1 || endIdx === -1) return text.trim();

  const before = text.slice(0, startIdx).trim();
  const after = text.slice(endIdx + BLOCK_END.length).trim();
  return [before, after].filter(Boolean).join("\n");
}

export function extractManagedBlock(text: string): string[] {
  const startIdx = text.indexOf(BLOCK_START);
  const endIdx = text.indexOf(BLOCK_END);
  if (startIdx === -1 || endIdx === -1) return [];

  return text
    .slice(startIdx + BLOCK_START.length, endIdx)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

export function buildNewCrontab(jobs: JobConfig[], ctx: CronContext): string {
  const current = readCurrentCrontab();
  const withoutManaged = stripManagedBlock(current);
  const activeJobs = jobs.filter((j) => !j.paused);

  if (activeJobs.length === 0) {
    return withoutManaged ? `${withoutManaged}\n` : "";
  }

  const block = buildManagedBlock(activeJobs, ctx);
  return withoutManaged ? `${withoutManaged}\n\n${block}\n` : `${block}\n`;
}

export function applyCrontab(newText: string): void {
  const result = spawnSync("crontab", ["-"], { input: newText, encoding: "utf8" });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") throw new Error(CRONTAB_MISSING);
  if (result.status !== 0) {
    throw new Error(`Falha ao instalar crontab: ${result.stderr || result.error?.message || "erro desconhecido"}`);
  }
}

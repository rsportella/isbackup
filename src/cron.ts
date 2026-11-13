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

function jobCronLine(job: JobConfig, ctx: CronContext): string {
  const cronExpr = resolveSchedule(job.schedule);
  const cliPath = path.join(ctx.projectRoot, "dist", "cli.js");
  // Sem redirecionamento de log aqui: o proprio "isbackup run" ja grava em logs/<job>.log
  // diretamente (job-log.ts), do mesmo jeito que um run disparado pela UI ou pelo self-heal —
  // redirecionar o shell tambem pro mesmo arquivo duplicaria cada linha.
  const command = `${process.execPath} ${cliPath} run ${job.name} --config ${ctx.configPath}`;
  return `${cronExpr} ${command} # isbackup:${job.name}`;
}

export function buildManagedBlock(jobs: JobConfig[], ctx: CronContext): string {
  const lines = jobs.map((job) => jobCronLine(job, ctx));
  return [BLOCK_START, ...lines, BLOCK_END].join("\n");
}

export function readCurrentCrontab(): string {
  const result = spawnSync("crontab", ["-l"], { encoding: "utf8" });
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
  if (result.status !== 0) {
    throw new Error(`Falha ao instalar crontab: ${result.stderr || result.error?.message || "erro desconhecido"}`);
  }
}

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { JobConfig } from "./types.js";
import {
  applyCrontab,
  buildManagedBlock,
  buildNewCrontab,
  extractManagedBlock,
  readCurrentCrontab,
  resolveSchedule,
  type CronContext,
} from "./cron.js";

/**
 * Onde as rotinas ficam agendadas, por sistema operacional:
 *  - macOS e Linux: o crontab do usuario (uma linha por job, ver cron.ts);
 *  - Windows: o Agendador de Tarefas, com UMA tarefa que roda a cada minuto e chama
 *    "isbackup tick", que dispara os jobs cujo horario (expressao cron) e agora. Assim qualquer
 *    rotina que funciona no cron funciona igual no Windows, sem traduzir cron pro formato limitado
 *    do schtasks — e pausar/editar um job nao exige reinstalar nada (o tick le o config.yaml).
 * O resto do app (painel, CLI) so conversa com esta interface.
 */

export type SchedulerKind = "cron" | "windows";

export interface SchedulerStatus {
  kind: SchedulerKind;
  /** Nome pra mostrar ao usuario ("cron", "Agendador do Windows"). */
  name: string;
  installed: boolean;
  /** Instalado, mas diferente do que o config atual geraria (precisa "Atualizar"). */
  stale: boolean;
  /** Uma linha por job ativo agendado. */
  lines: string[];
  /** O agendador do sistema nao esta disponivel (ex: Linux sem cron instalado): o que fazer. */
  unavailable?: string;
}

export interface Scheduler {
  kind: SchedulerKind;
  name: string;
  /** jobs = null quando o config.yaml esta invalido (o status ainda funciona, so nao compara). */
  status(jobs: JobConfig[] | null, ctx: CronContext): SchedulerStatus;
  /** Texto do que seria instalado (pro --dry-run da CLI). */
  preview(jobs: JobConfig[], ctx: CronContext): string;
  install(jobs: JobConfig[], ctx: CronContext): void;
  uninstall(ctx: CronContext): void;
}

const activeOf = (jobs: JobConfig[]) => jobs.filter((j) => !j.paused);

// ----- cron (macOS e Linux) ---------------------------------------------------------------------

export const cronScheduler: Scheduler = {
  kind: "cron",
  name: "cron",
  status(jobs, ctx) {
    let crontab: string;
    try {
      crontab = readCurrentCrontab();
    } catch (err) {
      // Ex: Linux minimo sem o pacote cron. O painel mostra o aviso em vez de um erro generico.
      return { kind: "cron", name: "cron", installed: false, stale: false, lines: [], unavailable: (err as Error).message };
    }
    const lines = extractManagedBlock(crontab);
    // Compara as linhas instaladas com as que o config atual geraria — nao so os nomes: um job
    // cujo schedule (ou caminho) mudou e nunca foi reinstalado continuaria rodando no horario velho.
    let stale = false;
    if (jobs && lines.length > 0) {
      const active = activeOf(jobs);
      const expected = active.length ? extractManagedBlock(buildManagedBlock(active, ctx)) : [];
      stale = lines.length !== expected.length || !lines.every((l) => expected.includes(l));
    }
    return { kind: "cron", name: "cron", installed: lines.length > 0, stale, lines };
  },
  preview(jobs, ctx) {
    return buildNewCrontab(jobs, ctx);
  },
  install(jobs, ctx) {
    applyCrontab(buildNewCrontab(jobs, ctx));
  },
  uninstall(ctx) {
    applyCrontab(buildNewCrontab([], ctx));
  },
};

// ----- Agendador de Tarefas (Windows) -----------------------------------------------------------

/** Nome da tarefa no Agendador. ISBACKUP_TASK_NAME existe pros testes nao mexerem na tarefa real. */
export function windowsTaskName(): string {
  return process.env.ISBACKUP_TASK_NAME || "isbackup";
}
const LAUNCHER_FILE = "isbackup-agendador.vbs";

export function windowsLauncherPath(ctx: CronContext): string {
  return path.join(path.dirname(ctx.configPath), LAUNCHER_FILE);
}

const vbsString = (s: string) => `"${s.replace(/"/g, '""')}"`;

/**
 * Script que o Agendador roda a cada minuto. Existe so pra iniciar o node SEM abrir uma janela de
 * console a cada minuto (o Agendador chamando o node direto piscaria uma janela preta).
 */
export function buildWindowsLauncher(
  ctx: CronContext,
  nodePath: string = process.execPath,
  dataHome: string | undefined = process.env.ISBACKUP_HOME,
): string {
  const cliPath = path.join(ctx.projectRoot, "dist", "cli.js");
  const command = `"${nodePath}" "${cliPath}" tick --config "${ctx.configPath}"`;
  const lines = [
    "' Gerado pelo isbackup (nao editar a mao). O Agendador de Tarefas do Windows roda este script",
    "' a cada minuto; ele chama \"isbackup tick\", que dispara os jobs cujo horario chegou.",
    "' (O VBScript so serve pra iniciar o node sem abrir uma janela de console.)",
    'Set shell = CreateObject("WScript.Shell")',
  ];
  if (dataHome) lines.push(`shell.Environment("Process")("ISBACKUP_HOME") = ${vbsString(path.resolve(dataHome))}`);
  lines.push(`shell.Run ${vbsString(command)}, 0, False`, "");
  return lines.join("\r\n");
}

// UTF-16LE com BOM: o formato que o wscript le sem estragar acentos em caminhos de pasta.
function writeLauncher(file: string, content: string): void {
  fs.writeFileSync(file, "﻿" + content, "utf16le");
}

function readLauncher(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf16le").replace(/^﻿/, "");
  } catch {
    return null;
  }
}

function schtasks(args: string[]) {
  const result = spawnSync("schtasks", args, { encoding: "utf8", windowsHide: true });
  if (result.error) {
    throw new Error(`Nao foi possivel executar o Agendador de Tarefas (schtasks): ${result.error.message}`);
  }
  return result;
}

function windowsTaskExists(): boolean {
  return schtasks(["/Query", "/TN", windowsTaskName()]).status === 0;
}

function jobLines(jobs: JobConfig[]): string[] {
  return activeOf(jobs).map((j) => `${resolveSchedule(j.schedule)} isbackup:${j.name}`);
}

export const windowsScheduler: Scheduler = {
  kind: "windows",
  name: "Agendador do Windows",
  status(jobs, ctx) {
    let installed: boolean;
    try {
      installed = windowsTaskExists();
    } catch (err) {
      return { kind: "windows", name: this.name, installed: false, stale: false, lines: [], unavailable: (err as Error).message };
    }
    if (!installed) return { kind: "windows", name: this.name, installed: false, stale: false, lines: [] };
    // A tarefa chama o script; o script guarda os caminhos (node, projeto, config). Se o projeto
    // mudou de pasta ou o node foi atualizado, o script nao bate mais com o esperado.
    const stale = readLauncher(windowsLauncherPath(ctx)) !== buildWindowsLauncher(ctx);
    return { kind: "windows", name: this.name, installed: true, stale, lines: jobs ? jobLines(jobs) : [] };
  },
  preview(jobs, ctx) {
    if (activeOf(jobs).length === 0) return `(a tarefa "${windowsTaskName()}" seria removida: nenhum job ativo)\n`;
    return [
      `Tarefa "${windowsTaskName()}" no Agendador de Tarefas: a cada 1 minuto, executa`,
      `  wscript.exe //B //Nologo "${windowsLauncherPath(ctx)}"`,
      "",
      `Conteudo de ${windowsLauncherPath(ctx)}:`,
      buildWindowsLauncher(ctx).replace(/\r\n/g, "\n"),
      "Jobs que o tick vai disparar (no horario de cada um):",
      ...jobLines(jobs).map((l) => `  ${l}`),
      "",
    ].join("\n");
  },
  install(jobs, ctx) {
    if (activeOf(jobs).length === 0) {
      this.uninstall(ctx); // mesmo comportamento do cron: sem job ativo, nada fica agendado
      return;
    }
    const launcher = windowsLauncherPath(ctx);
    writeLauncher(launcher, buildWindowsLauncher(ctx));
    const result = schtasks([
      "/Create",
      "/TN",
      windowsTaskName(),
      "/SC",
      "MINUTE",
      "/MO",
      "1",
      "/TR",
      `wscript.exe //B //Nologo "${launcher}"`,
      "/F",
    ]);
    if (result.status !== 0) {
      throw new Error(`Falha ao criar a tarefa no Agendador do Windows: ${(result.stderr || result.stdout).trim()}`);
    }
  },
  uninstall(ctx) {
    if (windowsTaskExists()) {
      const result = schtasks(["/Delete", "/TN", windowsTaskName(), "/F"]);
      if (result.status !== 0) {
        throw new Error(`Falha ao remover a tarefa do Agendador do Windows: ${(result.stderr || result.stdout).trim()}`);
      }
    }
    fs.rmSync(windowsLauncherPath(ctx), { force: true });
  },
};

export function getScheduler(platform: NodeJS.Platform = process.platform): Scheduler {
  return platform === "win32" ? windowsScheduler : cronScheduler;
}

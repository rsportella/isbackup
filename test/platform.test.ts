import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { isDueAt } from "../src/schedule-status.ts";
import {
  buildWindowsLauncher,
  cronScheduler,
  getScheduler,
  windowsLauncherPath,
  windowsScheduler,
} from "../src/scheduler.ts";
import { createTarGz, tarCommand } from "../src/file-backup.ts";
import { windowsMysqlDirs } from "../src/dump.ts";
import { hostPathFor } from "../src/web/settings.ts";
import type { CronContext } from "../src/cron.ts";
import type { JobConfig } from "../src/types.ts";
import { isWindows, tempDir } from "./helpers.ts";

const dir = tempDir();

describe("isDueAt (o tick do Windows dispara os jobs do minuto)", () => {
  const at = (h: number, m: number, s = 0) => new Date(2026, 10, 16, h, m, s);

  it("dispara no minuto certo, em qualquer segundo dele", () => {
    assert.equal(isDueAt("0 3 * * *", at(3, 0, 0)), true);
    assert.equal(isDueAt("0 3 * * *", at(3, 0, 59)), true);
  });

  it("nao dispara fora do minuto", () => {
    assert.equal(isDueAt("0 3 * * *", at(3, 1)), false);
    assert.equal(isDueAt("0 3 * * *", at(2, 59, 59)), false);
  });

  it("aceita as mesmas rotinas do cron (listas, intervalos, dias da semana)", () => {
    assert.equal(isDueAt("*/15 * * * *", at(10, 45, 30)), true);
    assert.equal(isDueAt("*/15 * * * *", at(10, 46)), false);
    assert.equal(isDueAt("0 8,9,10,11,12,13,14,15,16,17,18 * * *", at(14, 0)), true);
    // 16/11/2026 e segunda-feira
    assert.equal(isDueAt("0 9 * * 1-5", at(9, 0)), true);
    assert.equal(isDueAt("0 9 * * 0,6", at(9, 0)), false);
  });

  it("expressao invalida nunca dispara", () => {
    assert.equal(isDueAt("isso nao e cron", at(3, 0)), false);
  });
});

describe("agendador por sistema", () => {
  it("Windows usa o Agendador de Tarefas; macOS e Linux, o cron", () => {
    assert.equal(getScheduler("win32"), windowsScheduler);
    assert.equal(getScheduler("darwin"), cronScheduler);
    assert.equal(getScheduler("linux"), cronScheduler);
  });

  it("o script do Windows chama o tick com os caminhos certos, entre aspas", () => {
    const ctx: CronContext = {
      projectRoot: "C:\\Users\\Ana Lima\\isbackup",
      configPath: "C:\\Users\\Ana Lima\\isbackup\\config.yaml",
      logDir: "C:\\Users\\Ana Lima\\isbackup\\logs",
    };
    const vbs = buildWindowsLauncher(ctx, "C:\\Program Files\\nodejs\\node.exe", undefined);
    assert.ok(vbs.includes("\r\n"), "quebras de linha do Windows");
    assert.match(vbs, /shell\.Run """C:\\Program Files\\nodejs\\node\.exe"" ""C:\\Users\\Ana Lima\\isbackup[\\/]dist[\\/]cli\.js"" tick --config ""C:\\Users\\Ana Lima\\isbackup\\config\.yaml""", 0, False/);
    assert.doesNotMatch(vbs, /ISBACKUP_HOME/);
  });

  it("leva ISBACKUP_HOME junto quando a pasta de dados e separada", () => {
    const ctx: CronContext = { projectRoot: "/app", configPath: "/dados/config.yaml", logDir: "/dados/logs" };
    const vbs = buildWindowsLauncher(ctx, "node", "/dados");
    assert.match(vbs, /shell\.Environment\("Process"\)\("ISBACKUP_HOME"\) = ".*dados"/);
  });

  it("sem job ativo, a previa avisa que a tarefa seria removida", () => {
    const ctx: CronContext = { projectRoot: dir, configPath: path.join(dir, "config.yaml"), logDir: dir };
    const paused = [{ name: "x", schedule: "daily", paused: true } as JobConfig];
    assert.match(windowsScheduler.preview(paused, ctx), /seria removida/);
  });
});

describe("Agendador do Windows de verdade", { skip: !isWindows && "so roda no Windows" }, () => {
  const ctx: CronContext = { projectRoot: dir, configPath: path.join(dir, "config.yaml"), logDir: dir };
  const jobs = [{ name: "teste", schedule: "0 3 * * *", paused: false } as JobConfig];
  process.env.ISBACKUP_TASK_NAME = `isbackup-teste-${process.pid}`;
  after(() => {
    try {
      windowsScheduler.uninstall(ctx);
    } finally {
      delete process.env.ISBACKUP_TASK_NAME;
    }
  });

  it("instala, detecta mudanca e remove a tarefa", () => {
    windowsScheduler.install(jobs, ctx);
    let status = windowsScheduler.status(jobs, ctx);
    assert.equal(status.installed, true);
    assert.equal(status.stale, false);
    assert.deepEqual(status.lines, ["0 3 * * * isbackup:teste"]);

    // Projeto "mudou de pasta": o script nao bate mais com o esperado
    const moved = { ...ctx, projectRoot: path.join(dir, "outra-pasta") };
    assert.equal(windowsScheduler.status(jobs, moved).stale, true);

    windowsScheduler.uninstall(ctx);
    status = windowsScheduler.status(jobs, ctx);
    assert.equal(status.installed, false);
    assert.equal(fs.existsSync(windowsLauncherPath(ctx)), false);
  });
});

describe("tar (backup de arquivos)", () => {
  it("compacta uma pasta com subpastas e acentos, em qualquer sistema", async () => {
    const staging = path.join(dir, "staging");
    fs.mkdirSync(path.join(staging, "2026-11-16 (Completo)"), { recursive: true });
    fs.writeFileSync(path.join(staging, "2026-11-16 (Completo)", "relatório.txt"), "dados");
    fs.writeFileSync(path.join(staging, "raiz.log"), "log");
    const out = path.join(dir, "saida com espaço", "backup.tar.gz");
    fs.mkdirSync(path.dirname(out), { recursive: true });

    await createTarGz(staging, out);
    const list = spawnSync(tarCommand(), ["-tzf", out], { encoding: "utf8" });
    assert.equal(list.status, 0, list.stderr);
    const entries = list.stdout.split(/\r?\n/).map((e) => e.replace(/^\.\//, "")).filter(Boolean);
    assert.ok(entries.includes("raiz.log"), entries.join(", "));
    // Cada tar exibe acentos do seu jeito na listagem (o do macOS mostra bytes escapados):
    // confere o nome sem depender disso.
    assert.ok(entries.some((e) => /Completo\).*relat.*rio\.txt$/.test(e)), entries.join(", "));
  });

  it("no Windows usa o tar.exe do sistema", { skip: !isWindows && "so no Windows" }, () => {
    assert.match(tarCommand(), /System32[\\/]tar\.exe$/i);
  });
});

describe("cliente do MySQL no Windows", () => {
  it("acha MySQL Server e MariaDB nas pastas padrao, versao mais nova primeiro", () => {
    const pf = path.join(dir, "Program Files");
    const mk = (...p: string[]) => fs.mkdirSync(path.join(pf, ...p), { recursive: true });
    mk("MySQL", "MySQL Server 8.0", "bin");
    mk("MySQL", "MySQL Server 8.4", "bin");
    mk("MariaDB 11.4", "bin");
    mk("Outro Programa", "bin");

    const dirs = windowsMysqlDirs({ ProgramFiles: pf, SystemDrive: path.join(dir, "sem-xampp") });
    assert.deepEqual(dirs, [
      path.join(pf, "MySQL", "MySQL Server 8.4", "bin"),
      path.join(pf, "MySQL", "MySQL Server 8.0", "bin"),
      path.join(pf, "MariaDB 11.4", "bin"),
    ]);
  });
});

describe("pasta do Docker vista de um host Windows", () => {
  it("/data/backups vira C:\\...\\backups", () => {
    process.env.ISBACKUP_DOCKER = "1";
    process.env.ISBACKUP_HOME = "/data";
    process.env.ISBACKUP_HOST_DATA = "C:\\Users\\ana\\isbackup";
    try {
      assert.equal(hostPathFor("/data/backups"), "C:\\Users\\ana\\isbackup\\backups");
      assert.equal(hostPathFor("/data"), "C:\\Users\\ana\\isbackup");
    } finally {
      delete process.env.ISBACKUP_DOCKER;
      delete process.env.ISBACKUP_HOME;
      delete process.env.ISBACKUP_HOST_DATA;
    }
  });
});

describe("isbackup tick (CLI)", () => {
  it("dispara so os jobs ativos do minuto (dry-run)", () => {
    const home = path.join(dir, "tick-home");
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(
      path.join(home, "config.yaml"),
      [
        "jobs:",
        "  - name: agora",
        '    schedule: "* * * * *"',
        "    user: u",
        "    password: x",
        "  - name: pausado",
        '    schedule: "* * * * *"',
        "    user: u",
        "    password: x",
        "    paused: true",
        "  - name: outro-horario",
        '    schedule: "0 0 1 1 *"',
        "    user: u",
        "    password: x",
        "",
      ].join("\n"),
    );
    const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    const result = spawnSync(process.execPath, ["--import", "tsx", cli, "tick", "--dry-run"], {
      encoding: "utf8",
      env: { ...process.env, ISBACKUP_HOME: home },
    });
    const out = result.stdout + result.stderr;
    assert.equal(result.status, 0, out);
    assert.match(out, /\[dry-run\] job "agora"/);
    assert.doesNotMatch(out, /job "pausado"/);
    assert.doesNotMatch(out, /job "outro-horario"/);
  });
});

describe("agendador indisponivel (ex: Linux sem cron)", () => {
  it("o status explica o que instalar em vez de dar erro", () => {
    const savedPath = process.env.PATH;
    process.env.PATH = path.join(dir, "sem-programas"); // nenhum "crontab" a vista
    try {
      const ctx: CronContext = { projectRoot: dir, configPath: path.join(dir, "config.yaml"), logDir: dir };
      const status = cronScheduler.status([], ctx);
      assert.equal(status.installed, false);
      assert.match(status.unavailable ?? "", /crontab.*nao encontrado.*apt install cron/s);
    } finally {
      process.env.PATH = savedPath;
    }
  });
});

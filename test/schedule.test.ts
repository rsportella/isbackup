import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildManagedBlock,
  extractManagedBlock,
  resolveSchedule,
  stableNodePath,
  stripManagedBlock,
  type CronContext,
} from "../src/cron.ts";
import { computeScheduleStatus, estimateRetainedCount, estimateRunsPerDay } from "../src/schedule-status.ts";
import type { JobConfig } from "../src/types.ts";

describe("resolveSchedule", () => {
  it("traduz os presets", () => {
    assert.equal(resolveSchedule("hourly"), "0 * * * *");
    assert.equal(resolveSchedule(" Daily "), "0 3 * * *");
    assert.equal(resolveSchedule("weekly"), "0 3 * * 0");
    assert.equal(resolveSchedule("monthly"), "0 3 1 * *");
  });

  it("aceita cron de 5 campos e normaliza espacos", () => {
    assert.equal(resolveSchedule("0  8-18 * * 1,2,3"), "0 8-18 * * 1,2,3");
    assert.equal(resolveSchedule("*/15 * * * *"), "*/15 * * * *");
  });

  it("rejeita expressoes invalidas", () => {
    assert.throws(() => resolveSchedule("0 3 * *"), /Schedule invalido/);
    assert.throws(() => resolveSchedule("todo dia"), /Schedule invalido/);
    assert.throws(() => resolveSchedule("0 3 * * MON"), /Schedule invalido/);
    // tenta injetar um segundo comando no crontab
    assert.throws(() => resolveSchedule("0 3 * * *; rm -rf /"), /Schedule invalido/);
  });
});

describe("bloco gerenciado do crontab", () => {
  const ctx: CronContext = { projectRoot: "/app", configPath: "/app/config.yaml", logDir: "/app/logs" };
  const job = { name: "prod", schedule: "daily" } as JobConfig;

  it("gera uma linha por job e extrai de volta", () => {
    const block = buildManagedBlock([job, { ...job, name: "stg", schedule: "0 1 * * *" }], ctx);
    const lines = extractManagedBlock(`MAILTO=""\n${block}\n0 0 * * * outro-comando\n`);
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^0 3 \* \* \* \S+ \/app\/dist\/cli\.js run prod --config \/app\/config\.yaml # isbackup:prod$/);
    assert.match(lines[1], /^0 1 \* \* \* .* # isbackup:stg$/);
  });

  it("remove o bloco preservando as linhas do usuario", () => {
    const text = `MAILTO=""\n${buildManagedBlock([job], ctx)}\n0 0 * * * outro-comando\n`;
    assert.equal(stripManagedBlock(text), 'MAILTO=""\n0 0 * * * outro-comando');
  });
});

describe("stableNodePath", () => {
  it("mantem um caminho que nao tem link estavel", () => {
    assert.equal(stableNodePath("/caminho/que/nao/existe/node"), "/caminho/que/nao/existe/node");
  });
});

describe("saude do agendamento", () => {
  it("em dia se o ultimo backup e posterior a ultima execucao esperada", () => {
    assert.equal(computeScheduleStatus("0 * * * *", Date.now()).health, "ok");
  });

  it("atrasado sem backup ou com backup antigo", () => {
    assert.equal(computeScheduleStatus("0 * * * *", null).health, "overdue");
    assert.equal(computeScheduleStatus("0 * * * *", Date.now() - 3 * 3600_000).health, "overdue");
  });

  it("estima execucoes por dia e arquivos retidos", () => {
    assert.ok(Math.abs(estimateRunsPerDay("0 * * * *")! - 24) < 0.01);
    assert.ok(Math.abs(estimateRunsPerDay("0 3 * * *")! - 1) < 0.01);
    // seg a sex, das 8 as 18h: 11 runs x 5 dias / 7
    assert.ok(Math.abs(estimateRunsPerDay("0 8-18 * * 1-5")! - 55 / 7) < 0.01);
    assert.equal(estimateRetainedCount("0 3 * * *", 7), 7);
    assert.equal(estimateRetainedCount("0 3 * * *", 0), null);
  });
});

describe("linha do crontab com caminhos incomuns", async () => {
  const { cronShellArg } = await import("../src/cron.ts");

  it("caminhos comuns ficam sem aspas", () => {
    assert.equal(cronShellArg("/Users/a/isbackup/dist/cli.js"), "/Users/a/isbackup/dist/cli.js");
  });

  it("espaco, aspas e % sao protegidos", () => {
    assert.equal(cronShellArg("/Users/a/Meus Projetos/config.yaml"), "'/Users/a/Meus Projetos/config.yaml'");
    assert.equal(cronShellArg("/tmp/it's"), "'/tmp/it'\\''s'");
    assert.equal(cronShellArg("/tmp/100%"), "'/tmp/100\\%'");
  });

  it("projeto num caminho com espaco gera uma linha valida", () => {
    const ctx = { projectRoot: "/Users/a/Meus Projetos/isb", configPath: "/Users/a/Meus Projetos/isb/config.yaml", logDir: "/x" };
    const [line] = extractManagedBlock(buildManagedBlock([{ name: "prod", schedule: "daily" } as JobConfig], ctx));
    assert.match(line, / '\/Users\/a\/Meus Projetos\/isb\/dist\/cli\.js' run prod --config '\/Users\/a\/Meus Projetos\/isb\/config\.yaml' # isbackup:prod$/);
  });
});

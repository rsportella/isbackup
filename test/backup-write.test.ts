import fs from "node:fs";
import path from "node:path";
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { cleanupOldBackups, listBackupFiles, PARTIAL_SUFFIX } from "../src/backups.ts";
import { runBackup } from "../src/dump.ts";
import type { DatabaseJobConfig } from "../src/types.ts";
import { assertMode, isWindows, quietly, tempDir } from "./helpers.ts";

// Um "mysqldump" falso, colocado na frente do PATH: escreve bastante dado e sai com o codigo
// pedido. Assim da pra testar a gravacao do dump de verdade sem um banco.
const root = tempDir();
const bin = path.join(root, "bin");

before(() => {
  if (isWindows) return; // ver o "skip" abaixo
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "mysqldump"),
    `#!/bin/sh
head -c "\${FAKE_DUMP_BYTES:-3000000}" /dev/urandom | base64
[ -n "$FAKE_DUMP_STDERR" ] && echo "$FAKE_DUMP_STDERR" >&2
exit "\${FAKE_DUMP_EXIT:-0}"
`,
    { mode: 0o755 },
  );
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
});

function job(name: string): DatabaseJobConfig {
  return {
    type: "database",
    name,
    host: "h",
    port: 3306,
    user: "u",
    password: "p",
    databases: "all",
    gzip: true,
    outputDir: path.join(root, "out", name),
    retentionDays: 0,
    schedule: "daily",
    paused: false,
  };
}

// O mysqldump falso e um shell script: no Windows o node nao executa .sh/.cmd pelo nome, entao
// estes testes rodam so em macOS/Linux. A logica testada (gravacao via .partial) e a mesma no Windows.
const skip = isWindows && "mysqldump falso e um shell script";

describe("gravacao do dump", { skip }, () => {
  it("so conclui depois de o arquivo estar completo, com o nome final e permissao 600", async () => {
    const j = job("ok");
    const file = await quietly(() => runBackup(j, { logDir: path.join(root, "logs") }));
    assert.ok(file && fs.existsSync(file));
    const sizeAtResolve = fs.statSync(file).size;
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(fs.statSync(file).size, sizeAtResolve, "nada mais foi escrito depois de concluir");
    assertMode(file, 0o600);
    assert.deepEqual(fs.readdirSync(j.outputDir).filter((f) => f.endsWith(PARTIAL_SUFFIX)), []);
    const log = fs.readFileSync(path.join(root, "logs", "ok.log"), "utf8");
    const kb = (sizeAtResolve / 1024 / 1024).toFixed(1);
    assert.match(log, new RegExp(`concluido: .*\\(${kb.replace(".", "\\.")} MB\\)`));
  });

  it("dump que falha nao deixa arquivo nenhum (nem .partial)", async () => {
    const j = job("falha");
    process.env.FAKE_DUMP_EXIT = "2";
    process.env.FAKE_DUMP_STDERR = "Access denied";
    try {
      await assert.rejects(quietly(() => runBackup(j, { logDir: path.join(root, "logs") })), /codigo 2.*Access denied/);
    } finally {
      delete process.env.FAKE_DUMP_EXIT;
      delete process.env.FAKE_DUMP_STDERR;
    }
    assert.deepEqual(fs.readdirSync(j.outputDir).filter((f) => !f.startsWith(".")), []);
  });

  // Como root (ex: dentro de um container) a pasta sem permissao continua gravavel: nao da pra simular.
  const isRoot = process.getuid?.() === 0;
  it("falha de escrita (disco/pasta) vira erro, nao sucesso", { skip: isRoot && "rodando como root" }, async () => {
    const j = job("semescrita");
    fs.mkdirSync(j.outputDir, { recursive: true });
    fs.chmodSync(j.outputDir, 0o500); // sem permissao de escrita: o .partial nao pode ser criado
    try {
      await assert.rejects(
        quietly(() => runBackup(j, { logDir: path.join(root, "logs") })),
        /Falha ao gravar o arquivo de backup|EACCES/,
      );
    } finally {
      fs.chmodSync(j.outputDir, 0o700);
    }
  });
});

describe("arquivos .partial", { skip }, () => {
  it("nao aparecem como backup e sobras sao limpas apos o proximo backup", async () => {
    const j = job("sobra");
    fs.mkdirSync(j.outputDir, { recursive: true });
    const leftover = path.join(j.outputDir, `sobra_20260101_000000.sql.gz${PARTIAL_SUFFIX}`);
    fs.writeFileSync(leftover, "pela metade");
    assert.deepEqual(listBackupFiles(j), []);

    await quietly(() => runBackup(j, { logDir: path.join(root, "logs") }));
    assert.equal(fs.existsSync(leftover), false);
    assert.equal(listBackupFiles(j).length, 1);
  });

  it("limpeza nunca lanca (nao pode transformar um backup bom em falha)", async () => {
    const j = { ...job("limpeza"), outputDir: path.join(root, "nao-existe"), retentionDays: 1 };
    await quietly(() => cleanupOldBackups(j, { info() {}, error() {} }));
  });
});

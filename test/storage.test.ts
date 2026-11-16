import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readRawConfig, writeRawConfig } from "../src/config.ts";
import { decrypt, encrypt, generateKeyHex, isEncrypted, parseKey } from "../src/crypto.ts";
import { restrictToOwner, upsertEnvVar } from "../src/env-writer.ts";
import { createJobLogger, LOG_ROTATE_BYTES, readLastLines } from "../src/job-log.ts";
import { buildMysqlOptionsFileContent, writeMysqlOptionsFile } from "../src/mysql-credentials.ts";
import { computeSizeTrend } from "../src/web/api.ts";
import { fileMode, quietly, tempDir } from "./helpers.ts";

const dir = tempDir();

describe("config.yaml", () => {
  it("grava de forma atomica, preservando a permissao e sem deixar .tmp", () => {
    const cfg = path.join(dir, "config.yaml");
    fs.writeFileSync(cfg, "jobs: []\n", { mode: 0o640 });
    writeRawConfig(cfg, { jobs: [{ name: "a", schedule: "daily", host: undefined }] });
    assert.deepEqual(readRawConfig(cfg).jobs, [{ name: "a", schedule: "daily" }]);
    assert.equal(fileMode(cfg), 0o640);
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")), []);
  });

  it("config novo nasce 600", () => {
    const cfg = path.join(dir, "novo.yaml");
    writeRawConfig(cfg, { jobs: [] });
    assert.equal(fileMode(cfg), 0o600);
  });
});

describe(".env", () => {
  it("upsert corrige a permissao e preserva as outras linhas", () => {
    const env = path.join(dir, ".env");
    fs.writeFileSync(env, "A=1\nISB_TEST=velho\n", { mode: 0o644 });
    upsertEnvVar(env, "ISB_TEST", 'novo "valor"');
    assert.equal(fileMode(env), 0o600);
    assert.equal(fs.readFileSync(env, "utf8"), 'A=1\nISB_TEST="novo \\"valor\\""\n');
    assert.equal(process.env.ISB_TEST, 'novo "valor"');
  });

  it("restrictToOwner tira leitura de grupo/outros", () => {
    const f = path.join(dir, "aberto");
    fs.writeFileSync(f, "x", { mode: 0o644 });
    restrictToOwner(f);
    assert.equal(fileMode(f), 0o600);
    restrictToOwner(path.join(dir, "nao-existe")); // nao lanca
  });
});

describe("criptografia das senhas", () => {
  const key = parseKey(generateKeyHex());

  it("cifra e decifra (com IV aleatorio)", () => {
    const a = encrypt("s3nh@ çã", key);
    assert.ok(isEncrypted(a));
    assert.notEqual(a, encrypt("s3nh@ çã", key));
    assert.equal(decrypt(a, key), "s3nh@ çã");
  });

  it("chave errada ou valor adulterado falham com mensagem clara", () => {
    const a = encrypt("x", key);
    assert.throws(() => decrypt(a, parseKey(generateKeyHex())), /Nao foi possivel decifrar/);
    assert.throws(() => decrypt(a.slice(0, -4) + "AAAA", key), /Nao foi possivel decifrar/);
    assert.throws(() => parseKey("abc"), /ISBACKUP_ENCRYPTION_KEY invalida/);
  });
});

describe("option file do MySQL", () => {
  it("grava as credenciais com permissao 600", () => {
    const conn = { host: "h", port: 3306, user: "u", password: "p" };
    const file = writeMysqlOptionsFile(conn, "teste");
    try {
      assert.equal(fileMode(file), 0o600);
      assert.equal(fs.readFileSync(file, "utf8"), buildMysqlOptionsFileContent(conn));
      assert.match(buildMysqlOptionsFileContent(conn), /^\[client\]\nhost=h\nport=3306\nuser=u\npassword=p\n$/);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });
});

describe("tendencia de tamanho do backup", () => {
  const trend = (last: number, previous: number) => computeSizeTrend([{ size: last }, { size: previous }]).status;

  it("so alerta quando cai abaixo de 80% do anterior", () => {
    assert.equal(trend(120, 100), "ok");
    assert.equal(trend(100, 100), "ok");
    assert.equal(trend(95, 100), "ok");
    assert.equal(trend(80, 100), "ok");
    assert.equal(trend(79, 100), "warning");
    assert.equal(trend(0, 100), "warning");
  });

  it("sem dois backups, nao ha comparacao", () => {
    assert.equal(computeSizeTrend([]).status, "unknown");
    assert.equal(computeSizeTrend([{ size: 5 }]).status, "unknown");
  });
});

describe("logs por job", () => {
  const logDir = path.join(dir, "logs");

  it("le so as ultimas linhas, inclusive lendo em blocos e com UTF-8", () => {
    fs.mkdirSync(logDir, { recursive: true });
    const file = path.join(logDir, "big.log");
    const line = (i: number) => `linha ${i} ${"é".repeat(20)}`;
    fs.writeFileSync(file, Array.from({ length: 5000 }, (_, i) => line(i)).join("\n") + "\n");
    const last = readLastLines(file, 200, 1024);
    assert.equal(last.length, 200);
    assert.equal(last[0], line(4800));
    assert.equal(last[199], line(4999));
  });

  it("arquivo pequeno ou inexistente", () => {
    const file = path.join(logDir, "small.log");
    fs.writeFileSync(file, "a\nb\n");
    assert.deepEqual(readLastLines(file, 200), ["a", "b"]);
    assert.deepEqual(readLastLines(path.join(logDir, "nada.log"), 10), []);
  });

  it("rotaciona para .log.1 ao passar de 1 MB", async () => {
    const file = path.join(logDir, "x.log");
    fs.writeFileSync(file, Buffer.alloc(LOG_ROTATE_BYTES, 0x61));
    await quietly(() => createJobLogger(logDir, "x").info("depois da rotacao"));
    assert.equal(fs.statSync(`${file}.1`).size, LOG_ROTATE_BYTES);
    assert.match(fs.readFileSync(file, "utf8"), /^\[.+\] \[INFO\] depois da rotacao\n$/);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildConnectionTestTarget,
  buildRawJob,
  JobInputError,
  mergeEditedJob,
  parseDatabasesInput,
  parseJobName,
  parsePort,
  parseRetentionDays,
} from "../src/web/job-input.ts";
import type { JobConfig, RawJobConfig } from "../src/types.ts";

const encryptPassword = (plain: string) => `enc(${plain})`;

const dbBody = {
  type: "database",
  host: " db.local ",
  port: "3307",
  user: "root",
  password: "segredo",
  databases: "app, logs ,",
  schedule: "0 2 * * *",
  retentionDays: "14",
  gzip: false,
};

const filesBody = {
  type: "files",
  fileSourceProtocol: "ftp",
  fileSourceHost: "ftp.local",
  fileSourcePort: "",
  fileSourceUser: "u",
  fileSourcePassword: "p",
  fileSourceRemoteDir: "",
  fileSourcePattern: "*.zip",
  fileSourceNameContains: "",
  fileSourceModifiedWithinDays: "3",
  fileSourceSecure: true,
  schedule: "daily",
  retentionDays: "",
};

describe("parsers de campo", () => {
  it("nome do job", () => {
    assert.equal(parseJobName(" prod_1 "), "prod_1");
    assert.throws(() => parseJobName("meu job"), JobInputError);
    assert.throws(() => parseJobName("../etc"), JobInputError);
    assert.throws(() => parseJobName(""), JobInputError);
  });

  it("porta e retencao com padroes e limites", () => {
    assert.equal(parsePort(""), 3306);
    assert.equal(parsePort("22"), 22);
    assert.throws(() => parsePort("70000"), JobInputError);
    assert.throws(() => parsePort("3.5"), JobInputError);
    assert.equal(parseRetentionDays(undefined), 7);
    assert.equal(parseRetentionDays("0"), 0);
    assert.throws(() => parseRetentionDays("-1"), JobInputError);
  });

  it("lista de bancos", () => {
    assert.equal(parseDatabasesInput("all"), "all");
    assert.equal(parseDatabasesInput(""), "all");
    assert.equal(parseDatabasesInput(" , "), "all");
    assert.deepEqual(parseDatabasesInput("a, b"), ["a", "b"]);
    assert.deepEqual(parseDatabasesInput(["a", " b "]), ["a", "b"]);
    assert.throws(() => parseDatabasesInput(42), JobInputError);
  });
});

describe("buildRawJob", () => {
  it("cria job de banco normalizado e com senha cifrada", () => {
    assert.deepEqual(buildRawJob("prod", dbBody, { encryptPassword }), {
      name: "prod",
      type: "database",
      host: "db.local",
      port: 3307,
      user: "root",
      password: "enc(segredo)",
      databases: ["app", "logs"],
      schedule: "0 2 * * *",
      retentionDays: 14,
      gzip: false,
    });
  });

  it("cria job de arquivos com padroes", () => {
    const job = buildRawJob("arq", filesBody, { encryptPassword });
    assert.deepEqual(job.fileSource, {
      protocol: "ftp",
      host: "ftp.local",
      port: 21,
      user: "u",
      password: "enc(p)",
      remoteDir: "/",
      pattern: "*.zip",
      nameContains: undefined,
      modifiedWithinDays: 3,
      secure: true,
    });
    assert.equal(job.retentionDays, 7);
  });

  it("nao corta espacos da senha (fazem parte dela)", () => {
    const job = buildRawJob("prod", { ...dbBody, password: " a b " }, { encryptPassword });
    assert.equal(job.password, "enc( a b )");
  });

  it("senha obrigatoria na criacao", () => {
    assert.throws(() => buildRawJob("prod", { ...dbBody, password: "" }, { encryptPassword }), /password/);
    assert.throws(() => buildRawJob("arq", { ...filesBody, fileSourcePassword: "" }, { encryptPassword }), /password/);
  });

  it("na edicao, senha em branco mantem a atual", () => {
    const existing: RawJobConfig = { name: "prod", schedule: "daily", password: "enc:v1:antiga" }; // sem type = banco
    const job = buildRawJob("prod", { ...dbBody, password: "" }, { existing, encryptPassword });
    assert.equal(job.password, "enc:v1:antiga");
  });

  it("trocar de tipo exige senha nova (a do tipo antigo nao serve)", () => {
    const existing: RawJobConfig = { name: "x", type: "database", schedule: "daily", password: "enc:v1:db" };
    assert.throws(
      () => buildRawJob("x", { ...filesBody, fileSourcePassword: "" }, { existing, encryptPassword }),
      /fileSource\.password/,
    );
  });

  it("schedule invalido vira erro de validacao", () => {
    assert.throws(() => buildRawJob("prod", { ...dbBody, schedule: "sempre" }, { encryptPassword }), JobInputError);
  });
});

describe("mergeEditedJob", () => {
  it("preserva campos fora do formulario e descarta os do tipo antigo", () => {
    const existing: RawJobConfig = {
      name: "x",
      type: "database",
      host: "h",
      user: "u",
      password: "enc:v1:db",
      schedule: "daily",
      paused: true,
      outputDir: "/mnt/backups",
    };
    const edited = buildRawJob("x", filesBody, { existing, encryptPassword });
    const merged = mergeEditedJob(existing, edited);
    assert.equal(merged.paused, true);
    assert.equal(merged.outputDir, "/mnt/backups");
    assert.equal(merged.type, "files");
    assert.equal(merged.host, undefined);
    assert.equal(merged.password, undefined);
    assert.equal(Object.keys(merged)[0], "name");
  });
});

describe("buildConnectionTestTarget", () => {
  it("usa a senha salva (decifrada) quando o campo vem em branco", () => {
    const saved = { type: "database", password: "decifrada" } as JobConfig;
    const target = buildConnectionTestTarget({ ...dbBody, password: "" }, saved);
    assert.deepEqual(target, {
      type: "database",
      connection: { host: "db.local", port: 3307, user: "root", password: "decifrada" },
    });
  });

  it("sem senha nenhuma, pede a senha", () => {
    assert.throws(() => buildConnectionTestTarget({ ...dbBody, password: "" }), /Informe a senha/);
  });

  it("origem de arquivos testa o diretorio remoto, sem filtros", () => {
    const target = buildConnectionTestTarget({ ...filesBody, fileSourceRemoteDir: "/dados" });
    assert.equal(target.type, "files");
    if (target.type === "files") {
      assert.equal(target.source.remoteDir, "/dados");
      assert.equal(target.source.pattern, "*");
      assert.equal(target.source.modifiedWithinDays, null);
    }
  });
});

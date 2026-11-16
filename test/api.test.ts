import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/web/server.ts";
import { readRawConfig } from "../src/config.ts";
import { assertMode, quietly, tempDir } from "./helpers.ts";

// Sobe a API de verdade contra um projeto temporario (config.yaml, .env e logs proprios).
const root = tempDir();
const configPath = path.join(root, "config.yaml");
let baseUrl = "";
let close: () => void = () => {};

before(async () => {
  delete process.env.ISBACKUP_ENCRYPTION_KEY; // forca gerar uma chave nova no .env temporario
  fs.writeFileSync(configPath, "jobs: []\n");
  const server = createApp({ configPath, projectRoot: root, logDir: path.join(root, "logs") }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  close = () => server.close();
});
after(() => close());

async function api(method: string, url: string, body?: unknown) {
  const res = await quietly(() =>
    fetch(baseUrl + url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    }),
  );
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const job = {
  name: "prod",
  type: "database",
  host: "db.local",
  user: "root",
  password: "segredo",
  databases: "all",
  schedule: "daily",
  retentionDays: "7",
};

describe("API de jobs", () => {
  it("cria um job com a senha cifrada no config.yaml e a chave no .env (600)", async () => {
    const res = await api("POST", "/jobs", job);
    assert.equal(res.status, 201);
    assert.equal(res.body.name, "prod");
    assert.equal(res.body.password, undefined, "a API nunca devolve a senha");

    const saved = readRawConfig(configPath).jobs[0];
    assert.match(saved.password!, /^enc:v1:/);
    assert.match(fs.readFileSync(path.join(root, ".env"), "utf8"), /^ISBACKUP_ENCRYPTION_KEY="[0-9a-f]{64}"\n$/);
    assertMode(path.join(root, ".env"), 0o600);
  });

  it("recusa nome duplicado (409) e dados invalidos (400)", async () => {
    assert.equal((await api("POST", "/jobs", job)).status, 409);
    const bad = await api("POST", "/jobs", { ...job, name: "outro", schedule: "sempre" });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /Schedule invalido/);
    assert.equal((await api("POST", "/jobs", { ...job, name: "com espaco" })).status, 400);
  });

  it("edita mantendo a senha e os campos fora do formulario", async () => {
    await api("POST", "/jobs/prod/pause");
    const before = readRawConfig(configPath).jobs[0].password;
    const res = await api("PUT", "/jobs/prod", { ...job, password: "", schedule: "0 4 * * *" });
    assert.equal(res.status, 200);
    const saved = readRawConfig(configPath).jobs[0];
    assert.equal(saved.password, before);
    assert.equal(saved.schedule, "0 4 * * *");
    assert.equal(saved.paused, true);
    assert.equal(res.body.paused, true);
  });

  it("virar job de arquivos sem senha nova e recusado", async () => {
    const res = await api("PUT", "/jobs/prod", {
      type: "files",
      fileSourceHost: "ftp.local",
      fileSourceUser: "u",
      schedule: "daily",
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /fileSource\.password/);
    assert.equal(readRawConfig(configPath).jobs[0].type, "database", "nada foi gravado");
  });

  it("historico vazio e job inexistente", async () => {
    assert.deepEqual((await api("GET", "/jobs/prod/log")).body, { lines: [] });
    assert.equal((await api("PUT", "/jobs/nao-existe", job)).status, 404);
  });

  it("remove o job", async () => {
    assert.equal((await api("DELETE", "/jobs/prod")).status, 204);
    assert.deepEqual(readRawConfig(configPath).jobs, []);
  });
});

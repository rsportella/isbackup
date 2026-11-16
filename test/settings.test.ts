import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/web/server.ts";
import { readRawConfig } from "../src/config.ts";
import { hostPathFor, normalizeUserPath } from "../src/web/settings.ts";
import { quietly, tempDir } from "./helpers.ts";

const root = tempDir();
const configPath = path.join(root, "config.yaml");
let baseUrl = "";
let close: () => void = () => {};

before(async () => {
  fs.writeFileSync(
    configPath,
    [
      "defaults:",
      "  outputDir: ./backups",
      "jobs:",
      "  - name: loja",
      "    schedule: daily",
      "    user: u",
      "    password: x",
      "  - name: fixo",
      "    schedule: daily",
      "    user: u",
      "    password: x",
      `    outputDir: ${path.join(root, "pasta-fixa")}`,
      "",
    ].join("\n"),
  );
  const loja = path.join(root, "backups", "loja");
  fs.mkdirSync(loja, { recursive: true });
  for (const f of ["loja_20260101_030000.sql.gz", "loja_20260102_030000.sql.gz"]) fs.writeFileSync(path.join(loja, f), f);
  fs.writeFileSync(path.join(loja, ".loja.running.json.old"), "controle"); // oculto: nao se move

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
  return { status: res.status, body: await res.json() };
}

async function waitMoveDone() {
  for (let i = 0; i < 50; i++) {
    const { body } = await api("GET", "/settings");
    if (!body.move.running) return body;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("mudanca nao terminou");
}

describe("onde guardar os backups", () => {
  it("mostra a pasta atual (absoluta), espaco livre e jobs com pasta propria", async () => {
    const { status, body } = await api("GET", "/settings");
    assert.equal(status, 200);
    assert.equal(body.backupDir, path.join(root, "backups"));
    assert.equal(body.backupDirOnHost, path.join(root, "backups"));
    assert.equal(typeof body.freeBytes, "number");
    assert.deepEqual(body.jobsWithOwnDir, ["fixo"]);
    assert.equal(body.docker, false);
  });

  it("recusa caminho relativo e pasta dentro da atual", async () => {
    assert.equal((await api("PUT", "/settings", { backupDir: "backups2" })).status, 400);
    const nested = await api("PUT", "/settings", { backupDir: path.join(root, "backups", "sub") });
    assert.equal(nested.status, 400);
    assert.match(nested.body.error, /dentro da atual/);
  });

  it("troca a pasta e move os backups dos jobs (sem os arquivos de controle)", async () => {
    const novo = path.join(root, "HD Externo", "isbackup");
    const res = await api("PUT", "/settings", { backupDir: novo, moveExisting: true });
    assert.equal(res.status, 202);
    const done = await waitMoveDone();
    assert.equal(done.backupDir, novo);
    assert.equal(done.move.error, null);
    assert.equal(done.move.filesTotal, 2);

    assert.equal(readRawConfig(configPath).defaults?.outputDir, novo);
    assert.deepEqual(fs.readdirSync(path.join(novo, "loja")).sort(), [
      "loja_20260101_030000.sql.gz",
      "loja_20260102_030000.sql.gz",
    ]);
    // O arquivo oculto de controle ficou na origem (e por isso a pasta antiga nao foi apagada).
    assert.deepEqual(fs.readdirSync(path.join(root, "backups", "loja")), [".loja.running.json.old"]);

    const jobs = (await api("GET", "/jobs")).body as { name: string; backupCount: number; outputDir: string }[];
    const loja = jobs.find((j) => j.name === "loja")!;
    assert.equal(loja.backupCount, 2, "o painel ja enxerga os backups no lugar novo");
    assert.equal(jobs.find((j) => j.name === "fixo")!.outputDir, path.join(root, "pasta-fixa", "fixo"));
  });

  it("trocar sem mover deixa os arquivos onde estavam", async () => {
    const outra = path.join(root, "outra");
    const res = await api("PUT", "/settings", { backupDir: outra, moveExisting: false });
    assert.equal(res.status, 200);
    assert.equal(fs.existsSync(path.join(outra, "loja")), false);
    assert.equal(fs.readdirSync(path.join(root, "HD Externo", "isbackup", "loja")).length, 2);
  });

  it("no Docker a pasta nao e trocada pelo painel", async () => {
    process.env.ISBACKUP_DOCKER = "1";
    try {
      const res = await api("PUT", "/settings", { backupDir: path.join(root, "x") });
      assert.equal(res.status, 400);
      assert.match(res.body.error, /docker\.sh setup/);
    } finally {
      delete process.env.ISBACKUP_DOCKER;
    }
  });
});

describe("caminhos", () => {
  it("~ vira a pasta pessoal", () => {
    assert.equal(normalizeUserPath("~/Backups"), path.join(os.homedir(), "Backups"));
    assert.throws(() => normalizeUserPath("relativo/pasta"), /caminho completo/);
    assert.throws(() => normalizeUserPath("  "), /Informe a pasta/);
  });

  it("no Docker, /data/... e mostrado como a pasta do computador", () => {
    process.env.ISBACKUP_DOCKER = "1";
    process.env.ISBACKUP_HOME = "/data";
    process.env.ISBACKUP_HOST_DATA = "/Users/ana/isbackup";
    try {
      assert.equal(hostPathFor("/data/backups"), "/Users/ana/isbackup/backups");
      assert.equal(hostPathFor("/mnt/fora"), null);
    } finally {
      delete process.env.ISBACKUP_DOCKER;
      delete process.env.ISBACKUP_HOME;
      delete process.env.ISBACKUP_HOST_DATA;
    }
  });
});

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/web/server.ts";
import { allowedHostnames } from "../src/web/local-only.ts";
import { quietly, tempDir } from "./helpers.ts";

// O painel nao tem login: estes testes reproduzem os ataques de um site malicioso aberto no
// navegador de quem roda o isbackup (DNS rebinding e pedidos vindos de outro site).
const root = tempDir();
const backupFile = "loja_20260101_030000.sql.gz";
let port = 0;
let close: () => void = () => {};

before(async () => {
  fs.writeFileSync(
    path.join(root, "config.yaml"),
    "jobs:\n  - name: loja\n    schedule: daily\n    user: u\n    password: x\n",
  );
  fs.mkdirSync(path.join(root, "backups", "loja"), { recursive: true });
  fs.writeFileSync(path.join(root, "backups", "loja", backupFile), "conteudo do backup");
  fs.mkdirSync(path.join(root, "public"));
  fs.writeFileSync(path.join(root, "public", "index.html"), "<!doctype html><title>isbackup</title>");

  const server = createApp({
    configPath: path.join(root, "config.yaml"),
    projectRoot: root,
    logDir: path.join(root, "logs"),
  }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  port = (server.address() as AddressInfo).port;
  close = () => server.close();
});
after(() => close());

function request(method: string, urlPath: string, headers: Record<string, string> = {}) {
  return quietly(
    () =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request(
          { host: "127.0.0.1", port, method, path: urlPath, headers: { host: `127.0.0.1:${port}`, ...headers } },
          (res) => {
            let body = "";
            res.on("data", (c) => (body += c));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
          },
        );
        req.on("error", reject);
        req.end();
      }),
  );
}

const download = `/api/jobs/loja/backups/${backupFile}/download`;

describe("DNS rebinding (Host de outro dominio)", () => {
  const evil = () => ({ host: `site-malicioso.com:${port}`, origin: `http://site-malicioso.com:${port}` });

  it("nao le a lista de jobs", async () => {
    assert.equal((await request("GET", "/api/jobs", evil())).status, 403);
  });

  it("nao baixa backups", async () => {
    const res = await request("GET", download, evil());
    assert.equal(res.status, 403);
    assert.doesNotMatch(res.body, /conteudo do backup/);
  });

  it("nao serve nem a pagina do painel", async () => {
    assert.equal((await request("GET", "/", { host: `site-malicioso.com:${port}` })).status, 403);
  });
});

describe("pedidos vindos de outro site (sem rebinding)", () => {
  it("acao por POST simples com Origin de outro site e recusada", async () => {
    const res = await request("POST", "/api/cron/uninstall", {
      origin: "https://qualquer-site.com",
      "content-type": "text/plain",
    });
    assert.equal(res.status, 403);
  });

  it("navegador marcando cross-site e recusado ate em leitura", async () => {
    assert.equal((await request("GET", download, { "sec-fetch-site": "cross-site" })).status, 403);
    assert.equal((await request("GET", "/api/jobs", { "sec-fetch-site": "same-site" })).status, 403);
  });

  it("Origin \"null\" (iframe sandbox, arquivo local) nao passa em acoes", async () => {
    assert.equal((await request("POST", "/api/jobs/loja/stop", { origin: "null" })).status, 403);
  });

  it("Origin com a mesma maquina mas outra porta nao passa em acoes", async () => {
    assert.equal(
      (await request("POST", "/api/jobs/loja/stop", { origin: `http://127.0.0.1:${port + 1}` })).status,
      403,
    );
  });
});

describe("uso legitimo continua funcionando", () => {
  it("o proprio painel (mesma origem) le e age", async () => {
    const same = { origin: `http://127.0.0.1:${port}`, "sec-fetch-site": "same-origin" };
    assert.equal((await request("GET", "/api/jobs", same)).status, 200);
    // 409 = passou pela protecao e chegou na rota (o job so nao esta rodando)
    assert.equal((await request("POST", "/api/jobs/loja/stop", same)).status, 409);
  });

  it("localhost e [::1] tambem sao aceitos", async () => {
    assert.equal((await request("GET", "/api/jobs", { host: `localhost:${port}` })).status, 200);
    assert.equal((await request("GET", "/api/jobs", { host: `[::1]:${port}` })).status, 200);
  });

  it("digitar o endereco no navegador (sec-fetch-site: none) baixa o backup", async () => {
    const res = await request("GET", download, { "sec-fetch-site": "none" });
    assert.equal(res.status, 200);
    assert.match(res.body, /conteudo do backup/);
  });

  it("curl/CLI/healthcheck (sem cabecalhos de navegador) funcionam", async () => {
    assert.equal((await request("GET", "/api/cron/status")).status, 200);
    assert.equal((await request("GET", "/")).status, 200);
  });
});

describe("hosts extras (ISBACKUP_ALLOWED_HOSTS)", () => {
  it("acrescenta nomes aos locais", () => {
    const set = allowedHostnames(" backup.lan , NAS.local ");
    assert.ok(set.has("backup.lan") && set.has("nas.local") && set.has("127.0.0.1"));
    assert.ok(!allowedHostnames("").has("site-malicioso.com"));
  });
});

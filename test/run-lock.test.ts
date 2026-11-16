import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  clearRunLock,
  isCancelRequested,
  readRunLock,
  requestCancel,
  RunAlreadyActiveError,
  writeRunLock,
} from "../src/run-lock.ts";
import type { JobConfig } from "../src/types.ts";
import { tempDir } from "./helpers.ts";

const dir = tempDir();
const job = { name: "j", outputDir: dir } as JobConfig;
const lockFile = path.join(dir, ".j.running.json");

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""]);
  await new Promise((resolve) => child.on("exit", resolve));
  return child.pid!;
}

describe("lock de execucao", () => {
  afterEach(() => clearRunLock(job));

  it("um segundo run do mesmo job e recusado", () => {
    writeRunLock(job);
    assert.equal(readRunLock(job)?.pid, process.pid);
    assert.throws(() => writeRunLock(job), RunAlreadyActiveError);
  });

  it("run recusado nao apaga o pedido de Parar do run ativo", () => {
    writeRunLock(job);
    requestCancel(job);
    assert.throws(() => writeRunLock(job), RunAlreadyActiveError);
    assert.equal(isCancelRequested(job), true);
  });

  it("lock orfao (pid morto) e substituido, e o cancelamento antigo e limpo", async () => {
    fs.writeFileSync(lockFile, JSON.stringify({ pid: await deadPid(), startedAt: "x" }));
    requestCancel(job);
    writeRunLock(job);
    assert.equal(readRunLock(job)?.pid, process.pid);
    assert.equal(isCancelRequested(job), false);
  });

  it("lock recem-criado ainda vazio (outro processo escrevendo) nao e apagado", () => {
    fs.writeFileSync(lockFile, "");
    assert.throws(() => writeRunLock(job), RunAlreadyActiveError);
    assert.equal(fs.readFileSync(lockFile, "utf8"), "");
  });

  it("varios processos ao mesmo tempo: so um pega o lock", async () => {
    const runLock = fileURLToPath(new URL("../src/run-lock.ts", import.meta.url));
    const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
    const script =
      `import(${JSON.stringify(runLock)}).then((m) => {` +
      ` try { m.writeRunLock({ name: "race", outputDir: ${JSON.stringify(dir)} }); console.log("GOT"); setTimeout(() => {}, 800); }` +
      ` catch (e) { console.log(e.name); } })`;
    const run = () =>
      new Promise<string>((resolve) => {
        let out = "";
        const child = spawn(tsx, ["--input-type=module", "-e", script]);
        child.stdout.on("data", (d) => (out += d));
        child.on("exit", () => resolve(out.trim()));
      });

    const results = await Promise.all([run(), run(), run(), run()]);
    assert.equal(results.filter((r) => r === "GOT").length, 1, results.join(", "));
    assert.equal(results.filter((r) => r === "RunAlreadyActiveError").length, 3, results.join(", "));
  });
});

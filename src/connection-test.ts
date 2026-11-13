import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { spawnEnvWithFallbackPath } from "./dump.js";

export interface DbConnectionInfo {
  host: string;
  port: number;
  user: string;
  password: string;
}

/**
 * Testa uma conexao MySQL/MariaDB rodando `SELECT 1` de verdade via o cliente `mysql` — confirma
 * que o servidor responde E que essas credenciais realmente autenticam, sem rodar nenhum dump.
 * Importante usar `mysql -e` e nao `mysqladmin ping`: o `ping` retorna sucesso (exit 0) mesmo com
 * senha errada, contanto que o servidor responda (ele so testa se o processo esta vivo, nao se
 * a autenticacao funcionou) — verificado na pratica, nao e documentacao teorica.
 *
 * Mesma tecnica de dump.ts pra nao expor a senha na linha de comando: vai num arquivo temporario
 * 0600, apagado logo em seguida.
 */
export function testDatabaseConnection(conn: DbConnectionInfo): Promise<void> {
  const file = path.join(os.tmpdir(), `isbackup-test-${process.pid}-${crypto.randomBytes(6).toString("hex")}.cnf`);
  const content = [
    "[client]",
    `host=${conn.host}`,
    `port=${conn.port}`,
    `user=${conn.user}`,
    `password=${conn.password}`,
    "",
  ].join("\n");
  fs.writeFileSync(file, content, { mode: 0o600 });

  return new Promise<void>((resolve, reject) => {
    const child = spawn("mysql", [`--defaults-extra-file=${file}`, "--connect-timeout=5", "-e", "SELECT 1"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: spawnEnvWithFallbackPath(),
    });

    let stderrOutput = "";
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      fs.rmSync(file, { force: true });
      if (err) reject(err);
      else resolve();
    };

    child.stderr.on("data", (chunk: Buffer) => {
      stderrOutput += chunk.toString();
    });
    child.on("error", (err) => {
      finish(
        new Error(`Nao foi possivel executar "mysql": ${err.message}. Verifique se o mysql-client esta instalado.`),
      );
    });
    child.on("close", (code) => {
      if (code === 0) finish();
      else finish(new Error(`Conexao falhou.${stderrOutput ? " Detalhes: " + stderrOutput.trim() : ""}`));
    });
  });
}

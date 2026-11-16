import fs from "node:fs";
import { spawn } from "node:child_process";
import { spawnEnvWithFallbackPath } from "./dump.js";
import { writeMysqlOptionsFile, type MysqlConnection } from "./mysql-credentials.js";

/** Mantido como alias pra quem ja importava esse nome. */
export type DbConnectionInfo = MysqlConnection;

/**
 * Testa uma conexao MySQL/MariaDB rodando `SELECT 1` de verdade via o cliente `mysql` — confirma
 * que o servidor responde E que essas credenciais realmente autenticam, sem rodar nenhum dump.
 * Importante usar `mysql -e` e nao `mysqladmin ping`: o `ping` retorna sucesso (exit 0) mesmo com
 * senha errada, contanto que o servidor responda (ele so testa se o processo esta vivo, nao se
 * a autenticacao funcionou) — verificado na pratica, nao e documentacao teorica.
 *
 * As credenciais vao no mesmo option file temporario 0600 usado pelo dump (mysql-credentials.ts),
 * apagado logo em seguida.
 */
export function testDatabaseConnection(conn: MysqlConnection): Promise<void> {
  const file = writeMysqlOptionsFile(conn, "test");

  return new Promise<void>((resolve, reject) => {
    const child = spawn("mysql", [`--defaults-extra-file=${file}`, "--connect-timeout=5", "-e", "SELECT 1"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: spawnEnvWithFallbackPath(),
      windowsHide: true,
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

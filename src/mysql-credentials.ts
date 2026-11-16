import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export interface MysqlConnection {
  host: string;
  port: number;
  user: string;
  password: string;
}

/** Conteudo do option file ([client]) que o mysql/mysqldump le via --defaults-extra-file. */
export function buildMysqlOptionsFileContent(conn: MysqlConnection): string {
  return ["[client]", `host=${conn.host}`, `port=${conn.port}`, `user=${conn.user}`, `password=${conn.password}`, ""].join(
    "\n",
  );
}

/**
 * Grava as credenciais num option file temporario (0600) pra passar ao mysql/mysqldump via
 * --defaults-extra-file — em vez de -p na linha de comando, que fica visivel em `ps aux` pra
 * qualquer usuario local. Quem chama e responsavel por apagar o arquivo (no finally).
 *
 * Ponto unico usado pelo dump (dump.ts) e pelo "Testar conexao" (connection-test.ts) — antes
 * cada um tinha sua copia dessa logica.
 */
export function writeMysqlOptionsFile(conn: MysqlConnection, label: string): string {
  const file = path.join(os.tmpdir(), `isbackup-${label}-${process.pid}-${crypto.randomBytes(6).toString("hex")}.cnf`);
  fs.writeFileSync(file, buildMysqlOptionsFileContent(conn), { mode: 0o600 });
  return file;
}

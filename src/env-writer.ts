import fs from "node:fs";
import { generateKeyHex, parseKey } from "./crypto.js";

const ENCRYPTION_KEY_VAR = "ISBACKUP_ENCRYPTION_KEY";

function quoteEnvValue(value: string): string {
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
  return `"${escaped}"`;
}

/**
 * Escreve (ou atualiza) uma variavel no .env, preservando as demais linhas, e reflete
 * o valor em process.env imediatamente — sem isso o processo so veria a mudanca apos reiniciar.
 */
export function upsertEnvVar(envPath: string, key: string, value: string): void {
  const line = `${key}=${quoteEnvValue(value)}`;
  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  const lines = existing.length > 0 ? existing.split("\n") : [];

  const pattern = new RegExp(`^${key}=`);
  const idx = lines.findIndex((l) => pattern.test(l.trim()));
  if (idx >= 0) {
    lines[idx] = line;
  } else {
    if (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
    lines.push(line);
  }

  fs.writeFileSync(envPath, lines.join("\n").replace(/\n*$/, "\n"), { encoding: "utf8", mode: 0o600 });
  // `mode` so vale na criacao do arquivo — um .env que ja existia mantem a permissao antiga.
  restrictToOwner(envPath);
  process.env[key] = value;
}

/**
 * Deixa um arquivo legivel so pelo dono (600). O .env guarda a ISBACKUP_ENCRYPTION_KEY, que
 * decifra todas as senhas do config.yaml — com 644, qualquer usuario da maquina leria a chave.
 * Nunca derruba quem chamou: e uma protecao extra, nao um requisito pra funcionar.
 */
export function restrictToOwner(filePath: string): void {
  try {
    if ((fs.statSync(filePath).mode & 0o077) !== 0) fs.chmodSync(filePath, 0o600);
  } catch {
    // arquivo inexistente ou sem permissao de chmod — ignora
  }
}

/** Le a ISBACKUP_ENCRYPTION_KEY do .env (ja carregado em process.env), ou null se ainda nao existe. */
export function getEncryptionKeyOrNull(): Buffer | null {
  const hex = process.env[ENCRYPTION_KEY_VAR];
  return hex ? parseKey(hex) : null;
}

/** Como getEncryptionKeyOrNull, mas gera e persiste uma chave nova no .env se ainda nao existir. */
export function getOrCreateEncryptionKey(envPath: string): Buffer {
  const existing = getEncryptionKeyOrNull();
  if (existing) return existing;

  const hex = generateKeyHex();
  upsertEnvVar(envPath, ENCRYPTION_KEY_VAR, hex);
  return parseKey(hex);
}

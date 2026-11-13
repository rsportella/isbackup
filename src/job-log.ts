import fs from "node:fs";
import path from "node:path";
import { logger } from "./logger.js";

function timestamp(): string {
  return new Date().toISOString();
}

function appendToFile(logDir: string, jobName: string, line: string): void {
  try {
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, `${jobName}.log`), line + "\n");
  } catch {
    // Um problema pra escrever o log (disco cheio, permissao) nunca deve derrubar o backup em si.
  }
}

export interface JobLogger {
  info(message: string): void;
  error(message: string): void;
}

/**
 * Logger por job: grava tanto no console (`logger` global, pra quem estiver de olho no
 * terminal/journal do processo) quanto direto em `logs/<job>.log` — independente de qual
 * processo disparou o run (cron, self-heal, ou "Executar agora" pela UI).
 *
 * Antes, o arquivo por job so era preenchido quando o cron redirecionava o stdout/stderr do
 * processo `isbackup run <job>` pra ele (a propria linha gerada em cron.ts). Um backup disparado
 * de dentro do servidor da UI (self-heal ou "Executar agora") roda no MESMO processo Node do
 * servidor — as mensagens iam so pro console daquele processo, nunca pro arquivo por job. O
 * "Historico" da UI so le esse arquivo, entao um job que so tivesse rodado (ou falhado) via
 * self-heal/"Executar agora" aparecia com "Sem log ainda", mesmo tendo de fato rodado e ate
 * falhado — sem nenhuma pista do motivo. Escrever o arquivo explicitamente aqui, sempre, resolve
 * isso pros dois casos.
 */
export function createJobLogger(logDir: string, jobName: string): JobLogger {
  return {
    info(message: string): void {
      logger.info(message);
      appendToFile(logDir, jobName, `[${timestamp()}] [INFO] ${message}`);
    },
    error(message: string): void {
      logger.error(message);
      appendToFile(logDir, jobName, `[${timestamp()}] [ERROR] ${message}`);
    },
  };
}

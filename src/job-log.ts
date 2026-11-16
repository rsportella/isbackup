import fs from "node:fs";
import path from "node:path";
import { logger } from "./logger.js";

function timestamp(): string {
  return new Date().toISOString();
}

/** Acima desse tamanho, logs/<job>.log vira logs/<job>.log.1 (o .1 anterior e descartado). */
export const LOG_ROTATE_BYTES = 1024 * 1024; // 1 MB

/**
 * Rotacao simples (uma geracao): sem isso o log de cada job cresce pra sempre — um job de hora
 * em hora acumula centenas de KB por mes. Mantem o arquivo atual + o anterior (.1), o suficiente
 * pro Historico da UI e pra investigar uma falha recente.
 */
function rotateIfNeeded(file: string): void {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return; // ainda nao existe
  }
  if (size < LOG_ROTATE_BYTES) return;
  // Dois processos (cron + UI) podem tentar rotacionar juntos; rename e atomico, e se o outro
  // ja rotacionou este rename so falha — tudo bem.
  try {
    fs.renameSync(file, `${file}.1`);
  } catch {
    // ignora
  }
}

function appendToFile(logDir: string, jobName: string, line: string): void {
  try {
    fs.mkdirSync(logDir, { recursive: true });
    const file = path.join(logDir, `${jobName}.log`);
    rotateIfNeeded(file);
    fs.appendFileSync(file, line + "\n");
  } catch {
    // Um problema pra escrever o log (disco cheio, permissao) nunca deve derrubar o backup em si.
  }
}

/**
 * Le so as ultimas `maxLines` linhas do arquivo, a partir do fim, sem carregar o arquivo inteiro
 * na memoria (o Historico da UI pede isso a cada abertura). Le blocos de tras pra frente ate
 * juntar linhas suficientes ou chegar no inicio.
 */
export function readLastLines(file: string, maxLines: number, chunkBytes = 64 * 1024): string[] {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return [];
  }
  try {
    const size = fs.fstatSync(fd).size;
    let position = size;
    let buffer = Buffer.alloc(0);
    let newlines = 0;

    while (position > 0 && newlines <= maxLines) {
      const readSize = Math.min(chunkBytes, position);
      position -= readSize;
      const chunk = Buffer.alloc(readSize);
      fs.readSync(fd, chunk, 0, readSize, position);
      buffer = Buffer.concat([chunk, buffer]);
      for (const byte of chunk) if (byte === 0x0a) newlines += 1;
    }

    const lines = buffer.toString("utf8").split("\n").filter(Boolean);
    // Se parou no meio do arquivo, a primeira linha do buffer pode estar cortada (ou ter um
    // caractere UTF-8 partido) — descarta ela.
    if (position > 0) lines.shift();
    return lines.slice(-maxLines);
  } finally {
    fs.closeSync(fd);
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

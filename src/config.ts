import fs from "node:fs";
import path from "node:path";
import { load as parseYaml, dump as dumpYaml } from "js-yaml";
import type { JobConfig, JobType, RawConfig, RawJobConfig, RawFileSourceConfig, FileSourceConfig } from "./types.js";
import { isEncrypted, decrypt } from "./crypto.js";
import { getEncryptionKeyOrNull } from "./env-writer.js";

const ENV_VAR_PATTERN = /\$\{([A-Z0-9_]+)\}/g;

function interpolateEnv(value: string): string {
  return value.replace(ENV_VAR_PATTERN, (match, varName: string) => {
    const resolved = process.env[varName];
    if (resolved === undefined) {
      throw new Error(
        `Variavel de ambiente "${varName}" (referenciada como ${match}) nao esta definida. ` +
          `Defina-a no seu .env ou no ambiente antes de rodar.`,
      );
    }
    return resolved;
  });
}

/** Senha pode estar cifrada ("enc:v1:..."), referenciada do .env ("${VAR}", modo legado) ou em texto puro. */
function resolvePassword(value: string): string {
  if (isEncrypted(value)) {
    const key = getEncryptionKeyOrNull();
    if (!key) {
      throw new Error(
        "Essa senha esta cifrada mas ISBACKUP_ENCRYPTION_KEY nao esta definida no .env - sem a chave " +
          "nao e possivel decifra-la.",
      );
    }
    return decrypt(value, key);
  }
  return interpolateEnv(value);
}

function normalizeDatabases(value: RawJobConfig["databases"]): "all" | string[] {
  if (value === undefined || value === "all") return "all";
  if (typeof value === "string") return [value];
  return value;
}

/** Valida e normaliza a origem remota de um job do tipo "files" (mesmo estilo de checagem de
 * campo obrigatorio de normalizeJob, e reaproveita interpolateEnv/resolvePassword sem alteracoes). */
function normalizeFileSource(raw: RawFileSourceConfig | undefined, jobName: string): FileSourceConfig {
  if (!raw) {
    throw new Error(`Job "${jobName}": campo "fileSource" e obrigatorio para jobs do tipo "files".`);
  }
  if (raw.protocol !== "sftp" && raw.protocol !== "ftp") {
    throw new Error(`Job "${jobName}": campo "fileSource.protocol" deve ser "sftp" ou "ftp".`);
  }
  if (!raw.host || !raw.host.trim()) {
    throw new Error(`Job "${jobName}": campo "fileSource.host" e obrigatorio.`);
  }
  if (!raw.user || !raw.user.trim()) {
    throw new Error(`Job "${jobName}": campo "fileSource.user" e obrigatorio.`);
  }
  if (raw.password === undefined || raw.password === "") {
    throw new Error(`Job "${jobName}": campo "fileSource.password" e obrigatorio.`);
  }

  let modifiedWithinDays: number | null = null;
  if (raw.modifiedWithinDays !== undefined && raw.modifiedWithinDays !== null) {
    const n = Number(raw.modifiedWithinDays);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`Job "${jobName}": campo "fileSource.modifiedWithinDays" deve ser um numero positivo.`);
    }
    modifiedWithinDays = n;
  }

  const defaultPort = raw.protocol === "sftp" ? 22 : 21;
  return {
    protocol: raw.protocol,
    host: interpolateEnv(raw.host),
    port: raw.port ?? defaultPort,
    user: interpolateEnv(raw.user),
    password: resolvePassword(raw.password),
    remoteDir: raw.remoteDir?.trim() || "/",
    pattern: raw.pattern?.trim() || "*",
    nameContains: raw.nameContains?.trim() || null,
    modifiedWithinDays,
    secure: raw.secure ?? false,
  };
}

function normalizeJob(raw: RawJobConfig, defaults: RawConfig["defaults"], configDir: string): JobConfig {
  if (!raw.name || !raw.name.trim()) {
    throw new Error('Cada job precisa de um campo "name".');
  }
  if (!raw.schedule || !raw.schedule.trim()) {
    throw new Error(`Job "${raw.name}": campo "schedule" e obrigatorio.`);
  }

  const type: JobType = raw.type === "files" ? "files" : "database";
  const name = raw.name.trim();
  const outputDirBase = raw.outputDir ?? defaults?.outputDir ?? "./backups";
  // Resolvido relativo ao diretorio do config.yaml (nao ao cwd do processo),
  // porque quando o cron chama o comando o cwd nao e o diretorio do projeto.
  const absoluteOutputDir = path.resolve(configDir, outputDirBase);

  const base = {
    name,
    schedule: raw.schedule.trim(),
    outputDir: path.join(absoluteOutputDir, name),
    retentionDays: raw.retentionDays ?? defaults?.retentionDays ?? 7,
    paused: raw.paused ?? false,
  };

  if (type === "files") {
    return {
      ...base,
      type: "files",
      fileSource: normalizeFileSource(raw.fileSource, name),
    };
  }

  if (!raw.user || !raw.user.trim()) {
    throw new Error(`Job "${raw.name}": campo "user" e obrigatorio.`);
  }
  if (raw.password === undefined || raw.password === "") {
    throw new Error(`Job "${raw.name}": campo "password" e obrigatorio.`);
  }

  return {
    ...base,
    type: "database",
    host: raw.host ?? "localhost",
    port: raw.port ?? defaults?.port ?? 3306,
    user: interpolateEnv(raw.user),
    password: resolvePassword(raw.password),
    databases: normalizeDatabases(raw.databases),
    gzip: raw.gzip ?? defaults?.gzip ?? true,
  };
}

/** Le e faz o parse do config.yaml sem normalizar/validar — usado para editar e regravar o arquivo. */
export function readRawConfig(configPath: string): RawConfig {
  const resolvedPath = path.resolve(configPath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(
      `Arquivo de configuracao nao encontrado: ${resolvedPath}\n` +
        `Rode "isbackup init" para criar um config.yaml de exemplo.`,
    );
  }

  const text = fs.readFileSync(resolvedPath, "utf8");
  const parsed = parseYaml(text) as RawConfig | undefined;
  return { defaults: parsed?.defaults, jobs: parsed?.jobs ?? [] };
}

/** Regrava o config.yaml a partir da estrutura crua (perde comentarios/formatacao manual). */
export function writeRawConfig(configPath: string, raw: RawConfig): void {
  const resolvedPath = path.resolve(configPath);
  const text = dumpYaml(raw, { lineWidth: 100 });
  fs.writeFileSync(resolvedPath, text, "utf8");
}

export function loadConfig(configPath: string): JobConfig[] {
  const resolvedPath = path.resolve(configPath);
  const parsed = readRawConfig(resolvedPath);

  if (parsed.jobs.length === 0) {
    throw new Error(
      `Nenhum job encontrado em ${resolvedPath}. O arquivo precisa de uma chave "jobs" com ao menos um item.`,
    );
  }

  const configDir = path.dirname(resolvedPath);
  const names = new Set<string>();
  const jobs = parsed.jobs.map((rawJob) => {
    const job = normalizeJob(rawJob, parsed.defaults, configDir);
    if (names.has(job.name)) {
      throw new Error(`Nome de job duplicado: "${job.name}". Cada job precisa de um nome unico.`);
    }
    names.add(job.name);
    return job;
  });

  return jobs;
}

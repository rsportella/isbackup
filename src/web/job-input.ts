import { JOB_NAME_PATTERN } from "../config.js";
import { resolveSchedule } from "../cron.js";
import type { MysqlConnection } from "../mysql-credentials.js";
import type {
  FileProtocol,
  FileSourceConfig,
  JobConfig,
  JobType,
  RawFileSourceConfig,
  RawJobConfig,
} from "../types.js";

/**
 * Validacao/normalizacao do formulario de job da UI (corpo de POST/PUT /api/jobs e de
 * /api/jobs/test-connection). Antes isso vivia espalhado no api.ts, com a montagem do job
 * duplicada entre criar e editar (e com pequenas diferencas sem querer — ex: a senha era
 * "trimada" ao criar, mas nao ao editar). Tudo aqui e puro (sem I/O), entao e facil de testar.
 */

export { JOB_NAME_PATTERN };

export interface JobInputBody {
  name?: unknown;
  type?: unknown;
  host?: unknown;
  port?: unknown;
  user?: unknown;
  password?: unknown;
  databases?: unknown;
  schedule?: unknown;
  retentionDays?: unknown;
  gzip?: unknown;
  fileSourceProtocol?: unknown;
  fileSourceHost?: unknown;
  fileSourcePort?: unknown;
  fileSourceUser?: unknown;
  fileSourcePassword?: unknown;
  fileSourceRemoteDir?: unknown;
  fileSourcePattern?: unknown;
  fileSourceNameContains?: unknown;
  fileSourceModifiedWithinDays?: unknown;
  fileSourceSecure?: unknown;
  existingJobName?: unknown;
}

/** Erro de validacao do formulario — a API responde 400 com a mensagem. */
export class JobInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobInputError";
  }
}

const isBlank = (value: unknown) => value === undefined || value === null || value === "";

export function requireNonEmpty(value: unknown, field: string): string {
  const s = String(value ?? "").trim();
  if (!s) throw new JobInputError(`Campo "${field}" e obrigatorio.`);
  return s;
}

/** Texto opcional: string sem espacos nas pontas, ou undefined se vazio. */
function optionalText(value: unknown): string | undefined {
  return String(value ?? "").trim() || undefined;
}

/** Senha: nunca e "trimada" (espaco nas pontas pode ser parte da senha de verdade). */
function passwordText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function parseJobName(value: unknown): string {
  const name = requireNonEmpty(value, "name");
  if (!JOB_NAME_PATTERN.test(name)) {
    throw new JobInputError('Nome invalido: use apenas letras, numeros, "-" e "_", sem espacos.');
  }
  return name;
}

export function parseJobType(value: unknown): JobType {
  return value === "files" ? "files" : "database";
}

export function parseFileProtocol(value: unknown): FileProtocol {
  return value === "ftp" ? "ftp" : "sftp";
}

function parseIntInRange(value: unknown, fallback: number, min: number, max: number, message: string): number {
  const n = Number(isBlank(value) ? fallback : value);
  if (!Number.isInteger(n) || n < min || n > max) throw new JobInputError(message);
  return n;
}

export function parsePort(value: unknown, fallback = 3306): number {
  return parseIntInRange(value, fallback, 1, 65535, `Porta invalida: "${value}".`);
}

export function parseFileSourcePort(protocol: FileProtocol, value: unknown): number {
  return parseIntInRange(value, protocol === "sftp" ? 22 : 21, 1, 65535, `Porta de origem invalida: "${value}".`);
}

export function parseRetentionDays(value: unknown): number {
  return parseIntInRange(value, 7, 0, Number.MAX_SAFE_INTEGER, `Retencao invalida: "${value}".`);
}

export function parseModifiedWithinDays(value: unknown): number | undefined {
  if (isBlank(value)) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new JobInputError('Campo "modificados nos ultimos N dias" deve ser um numero positivo.');
  }
  return n;
}

export function parseDatabasesInput(value: unknown): "all" | string[] {
  if (value === "all" || isBlank(value)) return "all";
  const items = typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : null;
  if (items === null) throw new JobInputError('Campo "databases" invalido.');
  const parsed = items.map((s) => String(s).trim()).filter(Boolean);
  return parsed.length > 0 ? parsed : "all";
}

export function parseSchedule(value: unknown): string {
  const schedule = requireNonEmpty(value, "schedule");
  try {
    resolveSchedule(schedule);
  } catch (err) {
    throw new JobInputError((err as Error).message);
  }
  return schedule;
}

export interface BuildJobOptions {
  /** Job como esta hoje no config.yaml (edicao) — senha em branco no form mantem a atual. */
  existing?: RawJobConfig;
  /** Cifra uma senha nova pra gravar no config.yaml (injetado: depende da chave no .env). */
  encryptPassword: (plain: string) => string;
}

function buildFileSource(body: JobInputBody, opts: BuildJobOptions): RawFileSourceConfig {
  const protocol = parseFileProtocol(body.fileSourceProtocol);
  const host = requireNonEmpty(body.fileSourceHost, "fileSource.host");
  const user = requireNonEmpty(body.fileSourceUser, "fileSource.user");

  // So reaproveita a senha atual se o job ja era de arquivos (trocar de tipo exige senha nova).
  const previousPassword = opts.existing?.type === "files" ? opts.existing.fileSource?.password : undefined;
  const newPassword = passwordText(body.fileSourcePassword);
  if (!newPassword && !previousPassword) throw new JobInputError('Campo "fileSource.password" e obrigatorio.');

  return {
    protocol,
    host,
    port: parseFileSourcePort(protocol, body.fileSourcePort),
    user,
    password: newPassword ? opts.encryptPassword(newPassword) : previousPassword!,
    remoteDir: optionalText(body.fileSourceRemoteDir) ?? "/",
    pattern: optionalText(body.fileSourcePattern) ?? "*",
    nameContains: optionalText(body.fileSourceNameContains),
    modifiedWithinDays: parseModifiedWithinDays(body.fileSourceModifiedWithinDays),
    secure: Boolean(body.fileSourceSecure),
  };
}

/**
 * Monta o job (formato cru do config.yaml) a partir do formulario. Mesma funcao pra criar e
 * editar: na edicao, `opts.existing` permite manter a senha atual quando o campo vem em branco.
 * So devolve os campos que o formulario controla — quem edita mescla com os demais (paused,
 * outputDir...) via mergeEditedJob.
 */
export function buildRawJob(name: string, body: JobInputBody, opts: BuildJobOptions): RawJobConfig {
  const type = parseJobType(body.type);
  const schedule = parseSchedule(body.schedule);
  const retentionDays = parseRetentionDays(body.retentionDays);

  if (type === "files") {
    return { name, type: "files", schedule, retentionDays, fileSource: buildFileSource(body, opts) };
  }

  const user = requireNonEmpty(body.user, "user");
  const newPassword = passwordText(body.password);
  // Ausencia de "type" no config = job de banco (jobs antigos, de antes desse campo existir).
  const previousPassword = opts.existing && opts.existing.type !== "files" ? opts.existing.password : undefined;
  if (!newPassword && !previousPassword) throw new JobInputError('Campo "password" e obrigatorio.');

  return {
    name,
    type: "database",
    host: optionalText(body.host),
    port: parsePort(body.port),
    user,
    password: newPassword ? opts.encryptPassword(newPassword) : previousPassword!,
    databases: parseDatabasesInput(body.databases),
    schedule,
    retentionDays,
    gzip: typeof body.gzip === "boolean" ? body.gzip : true,
  };
}

// Campos que buildRawJob controla; o resto do job existente (paused, outputDir, ...) e mantido.
const FORM_FIELDS = [
  "type",
  "host",
  "port",
  "user",
  "password",
  "databases",
  "gzip",
  "fileSource",
  "schedule",
  "retentionDays",
] as const;

/**
 * Aplica a edicao: troca os campos do formulario e preserva o resto. Campos do tipo antigo que
 * nao existem no novo (ex: host/user de banco num job que virou "files") somem, em vez de ficar
 * lixo no config.yaml.
 */
export function mergeEditedJob(existing: RawJobConfig, edited: RawJobConfig): RawJobConfig {
  const preserved: Partial<RawJobConfig> = { ...existing };
  for (const field of FORM_FIELDS) delete preserved[field];
  return { ...edited, ...preserved, name: existing.name };
}

export type ConnectionTestTarget =
  | { type: "database"; connection: MysqlConnection }
  | { type: "files"; source: FileSourceConfig };

/**
 * Dados de conexao pro "Testar conexao", vindos do formulario. Senha em branco reaproveita a do
 * job salvo (`existingJob`, ja decifrada), desde que seja do mesmo tipo.
 */
export function buildConnectionTestTarget(body: JobInputBody, existingJob?: JobConfig): ConnectionTestTarget {
  const missingPassword = () => new JobInputError("Informe a senha para testar a conexao.");

  if (parseJobType(body.type) === "files") {
    const protocol = parseFileProtocol(body.fileSourceProtocol);
    const password =
      passwordText(body.fileSourcePassword) || (existingJob?.type === "files" ? existingJob.fileSource.password : "");
    if (!password) throw missingPassword();
    return {
      type: "files",
      source: {
        protocol,
        host: requireNonEmpty(body.fileSourceHost, "fileSource.host"),
        port: parseFileSourcePort(protocol, body.fileSourcePort),
        user: requireNonEmpty(body.fileSourceUser, "fileSource.user"),
        password,
        remoteDir: optionalText(body.fileSourceRemoteDir) ?? "/",
        pattern: "*",
        nameContains: null,
        modifiedWithinDays: null,
        secure: Boolean(body.fileSourceSecure),
      },
    };
  }

  const password = passwordText(body.password) || (existingJob?.type === "database" ? existingJob.password : "");
  if (!password) throw missingPassword();
  return {
    type: "database",
    connection: {
      host: optionalText(body.host) ?? "localhost",
      port: parsePort(body.port),
      user: requireNonEmpty(body.user, "user"),
      password,
    },
  };
}

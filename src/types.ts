export type JobType = "database" | "files";

// Campos comuns aos dois tipos de job — o resto do app (cron, retencao, self-heal, listagem de
// backups, lock de execucao) so depende destes, entao funciona pros dois tipos sem mudanca.
interface JobBase {
  name: string;
  schedule: string;
  outputDir: string;
  retentionDays: number;
  paused: boolean;
}

export interface DatabaseJobConfig extends JobBase {
  type: "database";
  host: string;
  port: number;
  user: string;
  password: string;
  databases: "all" | string[];
  gzip: boolean;
}

export type FileProtocol = "sftp" | "ftp";

export interface FileSourceConfig {
  protocol: FileProtocol;
  host: string;
  port: number;
  user: string;
  password: string;
  remoteDir: string;
  /** Wildcard simples (so "*"), ex: "*.log". Default "*" (todos). */
  pattern: string;
  /** Substring no nome do arquivo (case-insensitive), ou null se nao filtrar por isso. */
  nameContains: string | null;
  /** So inclui arquivos modificados nos ultimos N dias, ou null se nao filtrar por data. */
  modifiedWithinDays: number | null;
  /** FTPS (conexao segura). So relevante quando protocol === "ftp" (SFTP ja e cifrado via SSH). */
  secure: boolean;
}

export interface FilesJobConfig extends JobBase {
  type: "files";
  fileSource: FileSourceConfig;
}

/** Union discriminada por `type` — "database" (mysqldump, comportamento original) ou "files"
 * (puxa arquivos de um servidor SFTP/FTP remoto, filtra e compacta em tar.gz). */
export type JobConfig = DatabaseJobConfig | FilesJobConfig;

export interface RawDefaults {
  port?: number;
  outputDir?: string;
  retentionDays?: number;
  gzip?: boolean;
}

export interface RawFileSourceConfig {
  protocol?: FileProtocol;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  remoteDir?: string;
  pattern?: string;
  nameContains?: string;
  modifiedWithinDays?: number;
  secure?: boolean;
}

export interface RawJobConfig {
  name: string;
  /** Ausente = "database" (mantem os jobs existentes, criados antes deste campo existir, funcionando sem migracao). */
  type?: JobType;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  databases?: "all" | string | string[];
  fileSource?: RawFileSourceConfig;
  schedule: string;
  outputDir?: string;
  retentionDays?: number;
  gzip?: boolean;
  paused?: boolean;
}

export interface RawConfig {
  defaults?: RawDefaults;
  jobs: RawJobConfig[];
}

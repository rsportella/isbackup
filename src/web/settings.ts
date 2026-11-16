import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RawConfig } from "../types.js";
import { logger } from "../logger.js";

/**
 * "Onde guardar os backups": a pasta padrao (defaults.outputDir do config.yaml), que o painel
 * mostra e deixa trocar. Cada job grava numa subpasta com o proprio nome dentro dela. Jobs com um
 * outputDir proprio no config.yaml nao sao afetados.
 */

/** No container a pasta e definida ao subir (./docker.sh setup): la dentro so existe /data. */
export function isDocker(): boolean {
  return process.env.ISBACKUP_DOCKER === "1";
}

const DEFAULT_OUTPUT_DIR = "./backups";

export function currentBackupDir(raw: RawConfig, configPath: string): string {
  const configDir = path.dirname(path.resolve(configPath));
  return path.resolve(configDir, raw.defaults?.outputDir ?? DEFAULT_OUTPUT_DIR);
}

/** Caminho como o usuario o ve no proprio computador (no Docker, /data/... vira a pasta do host). */
export function hostPathFor(containerPath: string): string | null {
  if (!isDocker()) return containerPath;
  const hostData = process.env.ISBACKUP_HOST_DATA;
  const dataDir = path.resolve(process.env.ISBACKUP_HOME ?? "/data");
  const rel = path.relative(dataDir, containerPath);
  if (!hostData || !path.isAbsolute(hostData) || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return path.join(hostData, rel);
}

/** "~/x" e "~" viram a pasta do usuario; o resultado precisa ser um caminho absoluto. */
export function normalizeUserPath(input: string): string {
  let p = input.trim();
  if (!p) throw new SettingsError("Informe a pasta onde guardar os backups.");
  if (p === "~" || p.startsWith("~/")) p = path.join(os.homedir(), p.slice(1));
  if (!path.isAbsolute(p)) {
    throw new SettingsError('Use o caminho completo da pasta (ex: "/Volumes/HD Externo/Backups" ou "~/Backups").');
  }
  return path.resolve(p);
}

export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsError";
  }
}

/** Cria a pasta (se preciso) e confirma que da pra gravar nela antes de trocar a configuracao. */
export function ensureWritableDir(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    throw new SettingsError(`Nao foi possivel criar a pasta "${dir}": ${(err as Error).message}`);
  }
  if (!fs.statSync(dir).isDirectory()) throw new SettingsError(`"${dir}" nao e uma pasta.`);
  const probe = path.join(dir, `.isbackup-write-test-${process.pid}`);
  try {
    fs.writeFileSync(probe, "ok");
    fs.rmSync(probe, { force: true });
  } catch (err) {
    throw new SettingsError(`Sem permissao para gravar em "${dir}": ${(err as Error).message}`);
  }
}

export function freeBytes(dir: string): number | null {
  try {
    const s = fs.statfsSync(dir);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

/** Sugestoes pro campo: pasta no usuario e, no macOS, os discos externos montados em /Volumes. */
export function suggestedDirs(): string[] {
  const out = [path.join(os.homedir(), "Backups", "isbackup")];
  if (process.platform === "darwin") {
    try {
      for (const vol of fs.readdirSync("/Volumes")) {
        const full = path.join("/Volumes", vol);
        // O disco do sistema aparece em /Volumes como um link pra "/": nao e um disco externo.
        if (fs.realpathSync(full) === "/") continue;
        // Instaladores .dmg montados (ex: /Volumes/Slack) sao somente leitura: nao servem.
        try {
          fs.accessSync(full, fs.constants.W_OK);
        } catch {
          continue;
        }
        out.push(path.join(full, "isbackup"));
      }
    } catch {
      // sem /Volumes legivel
    }
  }
  return out;
}

// ----- mover os backups existentes ------------------------------------------------------------

export interface MoveStatus {
  running: boolean;
  from: string | null;
  to: string | null;
  filesDone: number;
  filesTotal: number;
  error: string | null;
  finishedAt: string | null;
}

const moveStatus: MoveStatus = {
  running: false,
  from: null,
  to: null,
  filesDone: 0,
  filesTotal: 0,
  error: null,
  finishedAt: null,
};

export function getMoveStatus(): MoveStatus {
  return { ...moveStatus };
}

/** Arquivos de backup de uma pasta de job (sem os arquivos de controle ocultos nem .partial). */
function movableFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => !f.startsWith(".") && !f.endsWith(".partial"))
      .filter((f) => fs.statSync(path.join(dir, f)).isFile());
  } catch {
    return [];
  }
}

async function moveFile(from: string, to: string): Promise<void> {
  try {
    fs.renameSync(from, to); // mesmo disco: instantaneo
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    // Outro disco: copia pra um temporario no destino, renomeia, e so entao apaga a origem.
    const tmp = `${to}.partial`;
    await fs.promises.copyFile(from, tmp);
    fs.renameSync(tmp, to);
    fs.rmSync(from);
  }
}

/**
 * Move os backups de cada job (subpasta com o nome do job) da pasta antiga pra nova, em segundo
 * plano: entre discos diferentes, gigabytes levam minutos. Um arquivo que ja existe no destino
 * nunca e sobrescrito (fica na origem). O painel acompanha por getMoveStatus().
 */
export function startMovingBackups(fromDir: string, toDir: string, jobNames: string[]): boolean {
  if (moveStatus.running) throw new SettingsError("Ja existe uma mudanca de pasta em andamento.");
  const plan: { from: string; to: string }[] = [];
  for (const name of jobNames) {
    const src = path.join(fromDir, name);
    const dst = path.join(toDir, name);
    for (const file of movableFiles(src)) plan.push({ from: path.join(src, file), to: path.join(dst, file) });
  }
  Object.assign(moveStatus, {
    running: plan.length > 0,
    from: fromDir,
    to: toDir,
    filesDone: 0,
    filesTotal: plan.length,
    error: null,
    finishedAt: plan.length > 0 ? null : new Date().toISOString(),
  });
  if (plan.length === 0) return false;

  void (async () => {
    let skipped = 0;
    try {
      for (const step of plan) {
        fs.mkdirSync(path.dirname(step.to), { recursive: true });
        if (fs.existsSync(step.to)) skipped += 1;
        else await moveFile(step.from, step.to);
        moveStatus.filesDone += 1;
      }
      // Remove as subpastas que ficaram vazias na origem.
      for (const name of jobNames) {
        try {
          fs.rmdirSync(path.join(fromDir, name));
        } catch {
          // nao vazia (sobrou algo) ou nao existe — tudo bem
        }
      }
      logger.info(
        `Backups movidos de ${fromDir} para ${toDir} (${moveStatus.filesDone - skipped} arquivo(s)` +
          `${skipped ? `, ${skipped} ja existia(m) no destino e ficaram na origem` : ""}).`,
      );
    } catch (err) {
      moveStatus.error = (err as Error).message;
      logger.error(`Falha ao mover backups para ${toDir}: ${moveStatus.error}`);
    } finally {
      moveStatus.running = false;
      moveStatus.finishedAt = new Date().toISOString();
    }
  })();
  return true;
}

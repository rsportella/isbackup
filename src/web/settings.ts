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
  // Dentro do container (sempre Linux) os caminhos sao posix; o do host pode ser de qualquer sistema.
  const dataDir = path.posix.resolve(process.env.ISBACKUP_HOME ?? "/data");
  const rel = path.posix.relative(dataDir, containerPath);
  if (!hostData || rel.startsWith("..") || path.posix.isAbsolute(rel)) return null;
  const hostIsWindows = /^[A-Za-z]:[\\/]/.test(hostData);
  if (!hostIsWindows && !hostData.startsWith("/")) return null;
  const hostPath = hostIsWindows ? path.win32 : path.posix;
  return rel ? hostPath.join(hostData, ...rel.split("/")) : hostData;
}

/** "~/x" e "~" viram a pasta do usuario; o resultado precisa ser um caminho absoluto. */
export function normalizeUserPath(input: string): string {
  let p = input.trim();
  if (!p) throw new SettingsError("Informe a pasta onde guardar os backups.");
  if (p === "~" || p.startsWith("~/")) p = path.join(os.homedir(), p.slice(1));
  if (!path.isAbsolute(p)) {
    throw new SettingsError(`Use o caminho completo da pasta (ex: ${exampleDir()} ou ~/Backups).`);
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

/** Exemplo de pasta no formato do sistema (texto de ajuda e placeholder do painel). */
export function exampleDir(platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") return "D:\\Backups\\isbackup";
  if (platform === "darwin") return "/Volumes/HD Externo/Backups";
  return "/mnt/hd-externo/backups";
}

function isWritableDir(dir: string): boolean {
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Sugestoes pro campo: uma pasta no usuario e os discos externos conectados — /Volumes no macOS,
 * /media e /mnt no Linux, as outras unidades (D:, E:...) no Windows. So entram locais gravaveis.
 */
export function suggestedDirs(platform: NodeJS.Platform = process.platform): string[] {
  const out = [path.join(os.homedir(), "Backups", "isbackup")];
  const subdirs = (dir: string) => {
    try {
      return fs.readdirSync(dir).map((name) => path.join(dir, name));
    } catch {
      return [];
    }
  };

  if (platform === "darwin") {
    for (const vol of subdirs("/Volumes")) {
      try {
        // O disco do sistema aparece em /Volumes como um link pra "/": nao e um disco externo.
        if (fs.realpathSync(vol) === "/") continue;
      } catch {
        continue;
      }
      // Instaladores .dmg montados (ex: /Volumes/Slack) sao somente leitura: nao servem.
      if (isWritableDir(vol)) out.push(path.join(vol, "isbackup"));
    }
  } else if (platform === "linux") {
    // /media/<usuario>/<disco> (montagem automatica) e /mnt/<disco>
    const user = os.userInfo().username;
    for (const disk of [...subdirs(path.join("/media", user)), ...subdirs("/mnt")]) {
      if (isWritableDir(disk)) out.push(path.join(disk, "isbackup"));
    }
  } else if (platform === "win32") {
    const systemDrive = (process.env.SystemDrive ?? "C:").toUpperCase();
    for (const letter of "DEFGHIJKLMNOPQRSTUVWXYZ") {
      const drive = letter + ":\\";
      if (letter + ":" !== systemDrive && isWritableDir(drive)) out.push(path.join(drive, "isbackup"));
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

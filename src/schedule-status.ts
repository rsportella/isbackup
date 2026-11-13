import { CronExpressionParser } from "cron-parser";

export type ScheduleHealth = "ok" | "overdue" | "unknown";

export interface ScheduleStatus {
  health: ScheduleHealth;
  /** Ultima vez que o job deveria ter rodado, segundo o schedule (ISO). */
  expectedSince: string | null;
}

// Cron real do sistema interpreta o schedule no fuso local da maquina, entao
// os calculos abaixo precisam usar o mesmo fuso.
const SYSTEM_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

function parseAt(resolvedCronExpression: string, currentDate: Date) {
  return CronExpressionParser.parse(resolvedCronExpression, { currentDate, tz: SYSTEM_TZ });
}

/**
 * Compara o horario do ultimo backup com a ultima ocorrencia esperada da
 * expressao cron (resolvida) para decidir se o job esta em dia ou atrasado.
 */
export function computeScheduleStatus(resolvedCronExpression: string, lastBackupMtimeMs: number | null): ScheduleStatus {
  let expectedSince: Date;
  try {
    expectedSince = parseAt(resolvedCronExpression, new Date()).prev().toDate();
  } catch {
    return { health: "unknown", expectedSince: null };
  }

  const health: ScheduleHealth =
    lastBackupMtimeMs !== null && lastBackupMtimeMs >= expectedSince.getTime() ? "ok" : "overdue";

  return { health, expectedSince: expectedSince.toISOString() };
}

/** Proxima execucao agendada (ISO), para mostrar uma contagem regressiva. */
export function computeNextRun(resolvedCronExpression: string): string | null {
  try {
    return parseAt(resolvedCronExpression, new Date()).next().toDate().toISOString();
  } catch {
    return null;
  }
}

// Conta as execucoes reais do cron numa janela de 28 dias (multiplo de semana, entao um schedule
// com dias da semana especificos — ex: "seg a sex, das 8 as 18h" — inclui os fins de semana na
// proporcao certa) e divide pelo tamanho da janela. Amostrar so alguns dias seguidos dava
// resultados enviesados: dependendo de onde "agora" caia, pegava ou nao o gap longo (noite,
// fim de semana) que o schedule tem uma vez por ciclo.
const WINDOW_MS = 28 * 24 * 60 * 60 * 1000;
const MIN_WINDOW_COUNT = 8; // abaixo disso a janela e esparsa demais (ex: mensal) pra contar
const MIN_SAMPLES = 4;
const MAX_SAMPLES = 1500; // salvaguarda pra schedules muito frequentes

/** Intervalo medio entre execucoes, amostrando ocorrencias futuras reais do cron. */
function estimateAverageIntervalMs(resolvedCronExpression: string): number | null {
  try {
    const now = Date.now();
    const expr = parseAt(resolvedCronExpression, new Date(now));
    const windowEnd = now + WINDOW_MS;
    const occurrences: number[] = [];

    // 1) tudo que cai dentro da janela
    while (occurrences.length < MAX_SAMPLES) {
      const t = expr.next().toDate().getTime();
      occurrences.push(t);
      if (t > windowEnd) break;
    }

    const inWindow = occurrences.filter((t) => t <= windowEnd).length;
    if (inWindow >= MIN_WINDOW_COUNT && occurrences.length < MAX_SAMPLES) {
      return WINDOW_MS / inWindow;
    }

    // 2) janela esparsa (semanal, mensal...) ou frequente demais: media dos gaps entre amostras
    while (occurrences.length < MIN_SAMPLES) {
      occurrences.push(expr.next().toDate().getTime());
    }
    if (occurrences.length < 2) return null;
    const span = occurrences[occurrences.length - 1] - occurrences[0];
    const avgIntervalMs = span / (occurrences.length - 1);
    return avgIntervalMs > 0 ? avgIntervalMs : null;
  } catch {
    return null;
  }
}

/** Estima quantos arquivos de backup a politica de retencao atual deve manter. */
export function estimateRetainedCount(resolvedCronExpression: string, retentionDays: number): number | null {
  if (retentionDays <= 0) return null;
  const avgIntervalMs = estimateAverageIntervalMs(resolvedCronExpression);
  if (!avgIntervalMs) return null;

  const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
  return Math.max(1, Math.round(retentionMs / avgIntervalMs));
}

/** Estima quantos backups esse schedule dispara por dia, em media. */
export function estimateRunsPerDay(resolvedCronExpression: string): number | null {
  const avgIntervalMs = estimateAverageIntervalMs(resolvedCronExpression);
  if (!avgIntervalMs) return null;

  const msPerDay = 24 * 60 * 60 * 1000;
  return msPerDay / avgIntervalMs;
}

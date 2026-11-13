const state = {
  jobs: [],
  polling: null,
};

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${i === 0 ? value : value.toFixed(1)} ${units[i]}`;
}

function formatCountdown(ms) {
  if (ms <= 0) return "agora";
  const totalSec = Math.floor(ms / 1000);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}min`;
  if (m > 0) return `${m}min ${s}s`;
  return `${s}s`;
}

const RING_RADIUS = 42;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

// Trava o preenchimento visivel em 97% enquanto o backup ainda nao e devido. Sem isso, jobs
// com intervalo longo (ex: 24h) ficam com um gap tao fino perto do horario que a ponta
// arredondada do traço "engole" ele, e o anel parece fechado mesmo faltando minutos.
const RING_MAX_VISIBLE_FRACTION = 0.97;

// Periodo da piscada lenta do anel enquanto o job roda (tem que bater com o CSS de .ring-running).
const RING_RUNNING_BLINK_MS = 2400;

function computeRingOffset(prevIso, nextIso, now) {
  const nextTime = new Date(nextIso).getTime();
  const prevTime = new Date(prevIso).getTime();
  if (!Number.isFinite(prevTime) || !Number.isFinite(nextTime) || nextTime <= prevTime) return 0;
  const rawFraction = (now - prevTime) / (nextTime - prevTime);
  const fraction = rawFraction >= 1 ? 1 : Math.min(RING_MAX_VISIBLE_FRACTION, Math.max(0, rawFraction));
  // Enche conforme se aproxima do proximo backup (cheio = prestes a rodar), nao o contrario.
  return RING_CIRCUMFERENCE * (1 - fraction);
}

function updateRingProgress(circle, now) {
  circle.style.strokeDashoffset = String(computeRingOffset(circle.dataset.prevRun, circle.dataset.nextRun, now));
}

function countdownRingHtml(job) {
  const isRunning = job.runState.status === "running";
  const runInfo = isRunning ? runningRingInfo(job.runState) : null;

  const centerLabel = isRunning
    ? runInfo.centerLabel
    : job.paused
      ? "Pausado"
      : job.nextRun
        ? formatCountdown(new Date(job.nextRun).getTime() - Date.now())
        : "—";
  const showCountdown = !isRunning && !job.paused && job.nextRun && job.expectedSince;
  // Calcula o offset inicial aqui (nao so no proximo tick) pra nao "flashar" o aro cheio
  // por ate 1s toda vez que o card e recriado (apos qualquer acao ou refresh).
  const initialOffset = showCountdown ? computeRingOffset(job.expectedSince, job.nextRun, Date.now()) : 0;
  // Rodando, o anel mostra o progresso do proprio job (nao a contagem pro proximo run) e pisca
  // devagar. O card e redesenhado a cada poll (1.5s), o que reiniciaria a animacao do zero;
  // um animation-delay negativo amarrado ao relogio mantem a fase continua entre redesenhos.
  const runningStyle = isRunning
    ? `stroke-dasharray:${RING_CIRCUMFERENCE};stroke-dashoffset:${RING_CIRCUMFERENCE * (1 - runInfo.fraction)};animation-delay:-${Date.now() % RING_RUNNING_BLINK_MS}ms`
    : "";

  return `
    <div class="next-run-ring-wrap${isRunning ? " running" : ""}"${runInfo?.tooltip ? ` data-tooltip="${escapeHtml(runInfo.tooltip)}"` : ""}>
      <svg class="next-run-ring" viewBox="0 0 100 100">
        <circle class="ring-track" cx="50" cy="50" r="${RING_RADIUS}"></circle>
        ${
          isRunning
            ? `<circle class="ring-progress ring-running" cx="50" cy="50" r="${RING_RADIUS}" style="${runningStyle}"></circle>`
            : showCountdown
              ? `<circle class="ring-progress" cx="50" cy="50" r="${RING_RADIUS}" data-prev-run="${job.expectedSince}" data-next-run="${job.nextRun}" style="stroke-dasharray:${RING_CIRCUMFERENCE};stroke-dashoffset:${initialOffset}"></circle>`
              : ""
        }
      </svg>
      <div class="ring-center-label${job.paused ? " ring-center-muted" : ""}"${
        !isRunning && !job.paused && job.nextRun ? ` data-next-run="${job.nextRun}"` : ""
      }>${escapeHtml(centerLabel)}</div>
    </div>
  `;
}

// Mostra a diferenca exata (nao so os dois tamanhos arredondados) porque em MB com 1 casa
// decimal um crescimento pequeno (poucos KB) pode arredondar pro mesmo numero dos dois lados,
// fazendo "Cresceu: 22.2 MB → 22.2 MB" parecer contraditorio.
function formatSizeDelta(diffBytes) {
  if (diffBytes === 0) return "0 B";
  const sign = diffBytes > 0 ? "+" : "-";
  return `${sign}${formatBytes(Math.abs(diffBytes))}`;
}

function sizeTrendBadgeHtml(job) {
  const trend = job.sizeTrend;
  if (!trend || trend.status === "unknown") return "";
  const ok = trend.status === "ok";
  const diff = trend.lastSize - trend.previousSize;
  const detail = `${formatBytes(trend.previousSize)} → ${formatBytes(trend.lastSize)} (${formatSizeDelta(diff)})`;
  const tooltip = ok ? `Cresceu: ${detail}` : `Nao cresceu (verifique o backup): ${detail}`;
  return `<span class="size-trend-badge size-trend-${ok ? "ok" : "warning"}" data-tooltip="${escapeHtml(tooltip)}">${ok ? "▲" : "!"}</span>`;
}

function formatDateTime(iso) {
  return new Date(iso).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function escapeHtml(str) {
  return String(str).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

let toastTimer = null;
function showToast(message, isError = false) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.className = "toast" + (isError ? " toast-error" : "");
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 3500);
}

async function apiFetch(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    let message = `Erro ${res.status}`;
    try {
      const body = await res.json();
      if (body.error) message = body.error;
    } catch {
      /* resposta sem corpo JSON */
    }
    throw new Error(message);
  }
  if (res.status === 204) return null;
  const contentType = res.headers.get("content-type") || "";
  return contentType.includes("application/json") ? res.json() : null;
}

async function loadJobs() {
  try {
    state.jobs = await apiFetch("/api/jobs");
  } catch (err) {
    document.getElementById("jobs").innerHTML = `<p class="error-line">${escapeHtml(err.message)}</p>`;
    return;
  }
  // Nao redesenha a grade inteira (render() troca o innerHTML de #jobs) enquanto um dropdown
  // estiver aberto — o polling roda a cada 1.5s sempre que algo esta rodando/atrasado, e se isso
  // cair bem no meio de um clique no "⋮" o menu recem-aberto e destruido/recriado fechado, sem
  // o usuario conseguir usa-lo. Os dados de state.jobs ficam atualizados de qualquer forma; so o
  // redesenho espera o menu fechar (o proximo poll, ou a proxima acao, pega o resto).
  if (!document.querySelector(".dropdown-menu:not([hidden])")) {
    render();
  }
  // Mantem o polling ligado nao so enquanto algo esta "Rodando", mas tambem enquanto algo esta
  // "Atrasado": o instante exato em que o horario esperado chega quase sempre aparece atrasado
  // por alguns segundos (o cron tem uma folga real ate de fato comecar a rodar), e sem isso o
  // card ficava preso nesse estado ate um refresh manual — nada continuava buscando a
  // atualizacao que o resolveria sozinho.
  const needsPolling = state.jobs.some(
    (j) => !j.paused && (j.runState.status === "running" || j.scheduleHealth === "overdue"),
  );
  if (needsPolling) startPolling();
  else stopPolling();
}

function startPolling() {
  if (state.polling) return;
  state.polling = setInterval(loadJobs, 1500);
}

function stopPolling() {
  if (state.polling) {
    clearInterval(state.polling);
    state.polling = null;
  }
}

async function loadCronStatus() {
  const badge = document.getElementById("cron-badge");
  const btn = document.getElementById("cron-toggle-btn");
  try {
    const status = await apiFetch("/api/cron/status");
    if (status.installed && status.stale) {
      badge.textContent = "Cron desatualizado";
      badge.className = "badge badge-running";
      btn.textContent = "Atualizar cron";
      btn.dataset.action = "install";
    } else if (status.installed) {
      const n = status.lines.length;
      badge.textContent = `Cron instalado (${n} job${n === 1 ? "" : "s"})`;
      badge.className = "badge badge-ok";
      btn.textContent = "Remover do cron";
      btn.dataset.action = "uninstall";
    } else {
      badge.textContent = "Cron nao instalado";
      badge.className = "badge badge-off";
      btn.textContent = "Instalar rotina no cron";
      btn.dataset.action = "install";
    }
  } catch (err) {
    badge.textContent = "Cron: erro ao consultar";
    badge.className = "badge badge-error";
    showToast(err.message, true);
  }
}

function formatElapsed(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  return `${min}min${remSec ? ` ${remSec}s` : ""}`;
}

/** Enquanto "Rodando", o texto curto do badge so diz a fase ("Rodando…"/"Compactando…") — todo
 * o detalhe (%, ETA, bytes, tempo decorrido) fica no centro do anel + tooltip (ver
 * runningRingInfo), pra nao esticar o card com um texto longo numa pilula. */
function combinedStatus(job) {
  if (job.runState.status === "running") {
    const label = job.runState.phase === "compressing" ? "Compactando…" : "Rodando…";
    return { cls: "running", label };
  }
  if (job.runState.status === "error") return { cls: "error", label: "Falhou" };
  if (job.runState.status === "cancelled") return { cls: "off", label: "Cancelado" };
  if (job.paused) return { cls: "off", label: "Pausado" };
  if (job.scheduleHealth === "overdue") return { cls: "error", label: "Atrasado" };
  if (job.scheduleHealth === "ok") return { cls: "ok", label: "Em dia" };
  return { cls: "", label: "" };
}

/** Texto curto pro centro do anel (que fica pulsando em azul enquanto roda) + tooltip com o
 * detalhe completo — "ha" no tooltip deixa explicito que o tempo decorrido nao e uma estimativa
 * de ETA (isso fica separado, no "faltam ~X"). */
function runningRingInfo(runState) {
  const elapsedMs = runState.startedAt ? Date.now() - new Date(runState.startedAt).getTime() : 0;

  if (runState.phase === "compressing") {
    return { centerLabel: "Compactando", fraction: 1, tooltip: `Compactando · rodando há ${formatElapsed(elapsedMs)}` };
  }

  const progress = runState.progress;
  if (progress && progress.bytesTotal > 0) {
    const pct = Math.min(100, Math.round((progress.bytesDone / progress.bytesTotal) * 100));
    let etaText = "";
    if (progress.bytesDone > 0 && elapsedMs > 0) {
      const rate = progress.bytesDone / elapsedMs;
      const remainingMs = (progress.bytesTotal - progress.bytesDone) / rate;
      etaText = ` · faltam ~${formatCountdown(remainingMs)}`;
    }
    return {
      centerLabel: `${pct}%`,
      fraction: Math.min(1, progress.bytesDone / progress.bytesTotal),
      tooltip: `${formatBytes(progress.bytesDone)} / ${formatBytes(progress.bytesTotal)} · ${progress.filesDone}/${progress.filesTotal} arquivo${progress.filesTotal === 1 ? "" : "s"}${etaText} · rodando há ${formatElapsed(elapsedMs)}`,
    };
  }
  // Dump de banco nao tem total conhecido: anel cheio, so piscando pra indicar atividade.
  return { centerLabel: "Rodando", fraction: 1, tooltip: runState.startedAt ? `Rodando há ${formatElapsed(elapsedMs)}` : null };
}

function jobCardHtml(job) {
  const status = combinedStatus(job);

  return `
    <article class="card${status.cls ? ` card-${status.cls}` : ""}" data-job="${escapeHtml(job.name)}">
      <div class="card-header">
        <h2>${escapeHtml(job.name)}</h2>
        <div class="card-menu">
          <button type="button" class="menu-trigger" data-action="toggle-menu" aria-label="Mais acoes">⋮</button>
          <div class="dropdown-menu" data-menu hidden>
            ${
              job.runState.status === "running"
                ? `<button type="button" class="btn-danger" data-action="stop">Parar</button>`
                : `<button type="button" data-action="run">Executar agora</button>`
            }
            <button type="button" data-action="toggle-pause">${job.paused ? "Retomar" : "Pausar"}</button>
            <button type="button" data-action="view-backups">Arquivos</button>
            <button type="button" data-action="view-log">Historico</button>
            <button type="button" data-action="edit-job">Configuracoes</button>
            <button type="button" class="btn-danger" data-action="delete-job">Excluir</button>
          </div>
        </div>
      </div>
      <div class="card-body">${countdownRingHtml(job)}</div>
      <div class="card-badges">
        ${status.label ? `<span class="badge badge-${status.cls}">${escapeHtml(status.label)}</span>` : "<span></span>"}
        ${sizeTrendBadgeHtml(job)}
      </div>
    </article>
  `;
}

function render() {
  const container = document.getElementById("jobs");
  if (state.jobs.length === 0) {
    container.innerHTML = `<p class="muted">Nenhum job configurado em config.yaml.</p>`;
    return;
  }
  container.innerHTML = state.jobs.map(jobCardHtml).join("");
}

async function renderBackupsInto(target, jobName) {
  try {
    const backups = await apiFetch(`/api/jobs/${encodeURIComponent(jobName)}/backups`);
    if (backups.length === 0) {
      target.innerHTML = `<p class="muted">Nenhum backup ainda.</p>`;
      return;
    }
    target.innerHTML = `
      <table class="backups-table">
        <tbody>
          ${backups
            .map(
              (b) => `
            <tr>
              <td>
                <div class="backup-filename">${escapeHtml(b.filename)}</div>
                <div class="muted">${formatBytes(b.size)} · ${formatDateTime(b.mtime)}</div>
              </td>
              <td class="backup-row-actions">
                <a class="btn btn-ghost btn-sm" href="/api/jobs/${encodeURIComponent(jobName)}/backups/${encodeURIComponent(b.filename)}/download">Baixar</a>
                <button class="btn btn-ghost btn-sm btn-danger" data-action="delete-backup" data-filename="${escapeHtml(b.filename)}">Apagar</button>
              </td>
            </tr>
          `,
            )
            .join("")}
        </tbody>
      </table>
    `;
  } catch (err) {
    target.innerHTML = `<p class="error-line">${escapeHtml(err.message)}</p>`;
  }
}

async function renderLogInto(target, jobName) {
  try {
    const { lines } = await apiFetch(`/api/jobs/${encodeURIComponent(jobName)}/log`);
    target.innerHTML = lines.length
      ? `<pre class="log-view">${escapeHtml(lines.join("\n"))}</pre>`
      : `<p class="muted">Sem log ainda (aparece apos a primeira execucao via cron ou UI).</p>`;
  } catch (err) {
    target.innerHTML = `<p class="error-line">${escapeHtml(err.message)}</p>`;
  }
}

async function runJob(jobName) {
  try {
    await apiFetch(`/api/jobs/${encodeURIComponent(jobName)}/run`, { method: "POST" });
    showToast(`Backup de "${jobName}" iniciado.`);
    await loadJobs();
  } catch (err) {
    showToast(err.message, true);
  }
}

async function runAll() {
  const idle = state.jobs.filter((j) => j.runState.status !== "running");
  if (idle.length === 0) return;
  await Promise.all(
    idle.map((j) =>
      apiFetch(`/api/jobs/${encodeURIComponent(j.name)}/run`, { method: "POST" }).catch((err) =>
        showToast(`${j.name}: ${err.message}`, true),
      ),
    ),
  );
  showToast("Backups iniciados.");
  await loadJobs();
}

function closeAllMenus(exceptMenu) {
  document.querySelectorAll(".dropdown-menu:not([hidden])").forEach((menu) => {
    if (menu !== exceptMenu) menu.hidden = true;
  });
}

const detailModalOverlay = document.getElementById("detail-modal-overlay");
const detailModalTitle = document.getElementById("detail-modal-title");
const detailModalBody = document.getElementById("detail-modal-body");
const DETAIL_MODAL_LABELS = { backups: "Arquivos", log: "Historico" };

async function openDetailModal(jobName, kind) {
  detailModalOverlay.dataset.job = jobName;
  detailModalOverlay.dataset.kind = kind;
  detailModalTitle.textContent = `${DETAIL_MODAL_LABELS[kind]} — ${jobName}`;
  detailModalBody.innerHTML = `<p class="muted">Carregando…</p>`;
  detailModalOverlay.hidden = false;
  await refreshDetailModal();
}

function closeDetailModal() {
  detailModalOverlay.hidden = true;
  delete detailModalOverlay.dataset.job;
  delete detailModalOverlay.dataset.kind;
}

async function refreshDetailModal() {
  const { job: jobName, kind } = detailModalOverlay.dataset;
  if (!jobName) return;
  if (kind === "backups") await renderBackupsInto(detailModalBody, jobName);
  else if (kind === "log") await renderLogInto(detailModalBody, jobName);
}

detailModalBody.addEventListener("click", async (e) => {
  const btn = e.target.closest('button[data-action="delete-backup"]');
  if (!btn) return;
  const jobName = detailModalOverlay.dataset.job;
  const filename = btn.dataset.filename;
  if (!confirm(`Apagar o backup "${filename}"? Essa acao nao pode ser desfeita.`)) return;
  try {
    await apiFetch(`/api/jobs/${encodeURIComponent(jobName)}/backups/${encodeURIComponent(filename)}`, {
      method: "DELETE",
    });
    showToast("Backup apagado.");
    await refreshDetailModal();
    await loadJobs();
  } catch (err) {
    showToast(err.message, true);
  }
});

document.querySelector('#detail-modal-overlay [data-action="close-detail"]').addEventListener("click", closeDetailModal);
detailModalOverlay.addEventListener("click", (e) => {
  if (e.target === detailModalOverlay) closeDetailModal();
});

document.getElementById("jobs").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;

  if (btn.dataset.action === "toggle-menu") {
    const menu = btn.nextElementSibling;
    const willOpen = menu.hidden;
    closeAllMenus();
    menu.hidden = !willOpen;
    return;
  }
  closeAllMenus();

  const jobName = e.target.closest(".card")?.dataset.job;
  if (!jobName) return;

  if (btn.dataset.action === "run") {
    await runJob(jobName);
  } else if (btn.dataset.action === "stop") {
    if (!confirm(`Parar o backup de "${jobName}" em andamento? O arquivo parcial sera descartado.`)) return;
    try {
      await apiFetch(`/api/jobs/${encodeURIComponent(jobName)}/stop`, { method: "POST" });
      showToast(`Parando "${jobName}"...`);
      await loadJobs();
    } catch (err) {
      showToast(err.message, true);
    }
  } else if (btn.dataset.action === "toggle-pause") {
    const job = state.jobs.find((j) => j.name === jobName);
    const endpoint = job?.paused ? "resume" : "pause";
    try {
      await apiFetch(`/api/jobs/${encodeURIComponent(jobName)}/${endpoint}`, { method: "POST" });
      showToast(job?.paused ? `Job "${jobName}" retomado.` : `Job "${jobName}" pausado.`);
      await loadJobs();
      await loadCronStatus();
    } catch (err) {
      showToast(err.message, true);
    }
  } else if (btn.dataset.action === "view-backups") {
    openDetailModal(jobName, "backups");
  } else if (btn.dataset.action === "view-log") {
    openDetailModal(jobName, "log");
  } else if (btn.dataset.action === "edit-job") {
    const job = state.jobs.find((j) => j.name === jobName);
    if (job) openJobModal(job);
  } else if (btn.dataset.action === "delete-job") {
    if (
      !confirm(
        `Remover o job "${jobName}" do config.yaml? Isso NAO apaga os backups ja existentes, so tira o job da lista/rotina.`,
      )
    )
      return;
    try {
      await apiFetch(`/api/jobs/${encodeURIComponent(jobName)}`, { method: "DELETE" });
      showToast(`Job "${jobName}" removido.`);
      await loadJobs();
      await loadCronStatus();
    } catch (err) {
      showToast(err.message, true);
    }
  }
});

document.getElementById("run-all-btn").addEventListener("click", runAll);
document.getElementById("refresh-btn").addEventListener("click", () => {
  loadJobs();
  loadCronStatus();
});

const SCHEDULE_PRESETS = new Set(["hourly", "daily", "weekly", "monthly"]);
// Campo "dia da semana" do cron: "*" (todos) ou lista de digitos 0-6 (0 = domingo).
const DOW = "(\\*|[0-6](?:,[0-6])*)";
const EVERY_N_HOURS_PATTERN = new RegExp(`^0 \\*/(\\d{1,2}) \\* \\* ${DOW}$`);
const HOURLY_ALL_DAY_PATTERN = new RegExp(`^0 \\* \\* \\* ${DOW}$`);
const DAILY_PATTERN = /^0 (\d{1,2}) \* \* \*$/;
const WEEKLY_PATTERN = /^0 (\d{1,2}) \* \* ([0-6])$/;
const MONTHLY_PATTERN = /^0 (\d{1,2}) (\d{1,2}) \* \*$/;
const WEEKDAYS_PATTERN = /^0 (\d{1,2}) \* \* ([0-6](?:,[0-6])*)$/;
// Lista com 2+ horas (janela gerada por "A cada hora"/"A cada N horas" com horario restrito).
// Precisa de pelo menos uma virgula pra nao colidir com DAILY_PATTERN (uma hora so).
const HOUR_WINDOW_PATTERN = new RegExp(`^0 (\\d{1,2}(?:,\\d{1,2})+) \\* \\* ${DOW}$`);

/** Quantas horas tem a janela [start..end], inclusive, com wraparound de meia-noite. */
function windowLength(startHour, endHour) {
  return ((endHour - startHour + 24) % 24) + 1;
}

/** Horas dentro da janela [start..end] a cada `step` horas, com wraparound de meia-noite. */
function buildWindowedHours(startHour, endHour, step) {
  const length = windowLength(startHour, endHour);
  const hours = [];
  for (let i = 0; i < length; i += step) {
    hours.push((startHour + i) % 24);
  }
  return hours;
}

/** Monta o cron de "a cada `step` horas" (1 = de hora em hora), restrito a [start..end] se nao for o dia todo. */
function buildIntervalSchedule(startHour, endHour, step, dow = "*") {
  if (windowLength(startHour, endHour) === 24) {
    return step === 1 ? `0 * * * ${dow}` : `0 */${step} * * ${dow}`;
  }
  return `0 ${buildWindowedHours(startHour, endHour, step).join(",")} * * ${dow}`;
}

/** Tenta reconhecer uma lista de horas como uma janela [start..end]/step gerada por este app. */
function detectHourWindow(hours) {
  if (hours.length < 2) return null;
  const start = hours[0];
  const step = ((hours[1] - hours[0] + 24) % 24) || 1;
  const end = hours[hours.length - 1];
  const expected = buildWindowedHours(start, end, step);
  const matches = expected.length === hours.length && expected.every((h, i) => h === hours[i]);
  return matches ? { start, end, step } : null;
}

function resetWeekdayButtons() {
  document.querySelectorAll(".weekday-btn").forEach((btn) => btn.setAttribute("aria-pressed", "false"));
}

function setWeekdayButtons(days) {
  const set = new Set(days);
  document.querySelectorAll(".weekday-btn").forEach((btn) => {
    btn.setAttribute("aria-pressed", set.has(btn.dataset.day) ? "true" : "false");
  });
}

function getSelectedWeekdays() {
  return Array.from(document.querySelectorAll('.weekday-btn[aria-pressed="true"]')).map((btn) => btn.dataset.day);
}

/** Marca os botoes a partir do campo dia-da-semana de um cron ("*" = nenhum marcado = todos os dias). */
function setWeekdayButtonsFromCron(dowField) {
  setWeekdayButtons(dowField === "*" ? [] : dowField.split(","));
}

/** Campo dia-da-semana do cron a partir dos botoes: "*" se nenhum ou todos os 7 marcados. */
function readWeekdaysCron() {
  const days = getSelectedWeekdays();
  return days.length === 0 || days.length === 7 ? "*" : days.join(",");
}

// Modos que aceitam restringir os dias da semana (nenhum marcado = todos os dias).
const WEEKDAY_FILTER_MODES = new Set(["hourly", "everyNHours", "daily", "weekdays"]);

function applyScheduleModeVisibility(mode) {
  const show = (id, visible) => {
    document.getElementById(id).hidden = !visible;
  };
  show("field-schedule-custom", mode === "custom");
  show("field-schedule-hours-row", mode === "everyNHours");
  show("field-hourly-window-row", mode === "hourly");
  show("field-everyn-window-row", mode === "everyNHours");
  show("hourly-window-hint", mode === "hourly" || mode === "everyNHours");
  show("field-weekday-picker-row", WEEKDAY_FILTER_MODES.has(mode));
  show("field-weekdays-row", mode === "weekdays");
  show("field-daily-row", mode === "daily");
  show("field-weekly-row", mode === "weekly");
  show("field-monthly-row", mode === "monthly");
  document.getElementById("weekday-picker-hint").textContent =
    mode === "weekdays" ? "Marque ao menos um dia." : "Nenhum dia marcado = todos os dias.";
}

/** Mesmo padrao de applyScheduleModeVisibility: mostra os campos de banco ou os de arquivos
 * (origem SFTP/FTP), conforme o tipo de job escolhido. */
function applyJobTypeVisibility(type) {
  const isFiles = type === "files";
  const isEdit = jobForm.dataset.mode === "edit";
  document.getElementById("field-database-fields").hidden = isFiles;
  document.getElementById("field-files-fields").hidden = !isFiles;
  document.getElementById("field-gzip-row").hidden = isFiles; // arquivos sempre viram .tar.gz, sem escolha
  // O campo de senha do banco fica dentro de um container escondido quando o tipo e "arquivos" —
  // se continuasse "required" o navegador tenta focar um campo invisivel pra validar e trava o
  // submit com um erro silencioso ("not focusable"). So e obrigatorio na criacao de um job banco.
  jobForm.elements.password.required = !isEdit && !isFiles;
  if (isFiles) applyFileProtocolVisibility(jobForm.elements.fileSourceProtocol.value);
}

/** FTPS so faz sentido pro protocolo FTP (SFTP ja e cifrado via SSH). */
function applyFileProtocolVisibility(protocol) {
  document.getElementById("field-file-secure-row").hidden = protocol !== "ftp";
  jobForm.elements.fileSourcePort.placeholder = protocol === "ftp" ? "21" : "22";
}

const jobModalOverlay = document.getElementById("job-modal-overlay");
const jobForm = document.getElementById("job-form");
const jobFormError = document.getElementById("job-form-error");

// "Salvar" so libera depois de um "Testar conexao" com sucesso — evita criar (ou editar) um job
// com host/usuario/senha errados sem o usuario perceber antes de salvar. Qualquer mudanca num
// campo que afete a conexao revoga um teste anterior, forcando testar de novo.
const CONNECTION_FIELD_NAMES = new Set([
  "type",
  "host",
  "port",
  "user",
  "password",
  "fileSourceProtocol",
  "fileSourceHost",
  "fileSourcePort",
  "fileSourceUser",
  "fileSourcePassword",
  "fileSourceRemoteDir",
  "fileSourceSecure",
]);

function setConnectionTested(ok) {
  jobForm.dataset.connectionTested = ok ? "true" : "false";
  jobForm.querySelector('button[type="submit"]').disabled = !ok;
}

function hideTestConnectionResults() {
  document.querySelectorAll(".test-connection-result").forEach((el) => {
    el.hidden = true;
  });
}

function markConnectionUntested() {
  if (jobForm.dataset.connectionTested === "false") return;
  setConnectionTested(false);
  hideTestConnectionResults();
}

jobForm.addEventListener("input", (e) => {
  if (CONNECTION_FIELD_NAMES.has(e.target.name)) markConnectionUntested();
});

function openJobModal(job, initialType) {
  const isEdit = Boolean(job);
  jobForm.reset();
  jobFormError.hidden = true;
  jobForm.dataset.mode = isEdit ? "edit" : "create";
  jobForm.dataset.originalName = isEdit ? job.name : "";

  document.getElementById("job-modal-title").textContent = isEdit ? `Editar "${job.name}"` : "Novo job";

  const jobType = isEdit ? (job.type === "files" ? "files" : "database") : initialType === "files" ? "files" : "database";
  jobForm.elements.type.value = jobType;

  jobForm.elements.name.value = isEdit ? job.name : "";
  jobForm.elements.name.disabled = isEdit;

  const isDbJob = jobType === "database";
  jobForm.elements.host.value = isDbJob && isEdit ? job.host : "";
  jobForm.elements.port.value = isDbJob && isEdit ? job.port : 3306;
  jobForm.elements.user.value = isDbJob && isEdit ? job.user : "";
  jobForm.elements.password.value = "";
  document.getElementById("password-hint").textContent = isEdit
    ? "Deixe em branco para manter a senha atual."
    : "Fica cifrada dentro do config.yaml (chave em .env).";

  const isAllDbs = !isDbJob || !isEdit || job.databases === "all";
  jobForm.elements.dbMode.value = isAllDbs ? "all" : "specific";
  const databasesInput = document.getElementById("field-databases");
  databasesInput.value = isDbJob && isEdit && Array.isArray(job.databases) ? job.databases.join(", ") : "";
  databasesInput.disabled = isAllDbs;

  const fileSource = jobType === "files" && isEdit ? job.fileSource : null;
  jobForm.elements.fileSourceProtocol.value = fileSource ? fileSource.protocol : "sftp";
  jobForm.elements.fileSourceHost.value = fileSource ? fileSource.host : "";
  jobForm.elements.fileSourcePort.value = fileSource ? fileSource.port : "";
  jobForm.elements.fileSourceUser.value = fileSource ? fileSource.user : "";
  jobForm.elements.fileSourcePassword.value = "";
  document.getElementById("file-password-hint").textContent = fileSource
    ? "Deixe em branco para manter a senha remota atual."
    : "Fica cifrada dentro do config.yaml (mesma chave em .env).";
  jobForm.elements.fileSourceRemoteDir.value = fileSource ? fileSource.remoteDir : "";
  jobForm.elements.fileSourcePattern.value = fileSource ? fileSource.pattern : "";
  jobForm.elements.fileSourceNameContains.value = fileSource ? fileSource.nameContains ?? "" : "";
  jobForm.elements.fileSourceModifiedWithinDays.value = fileSource ? (fileSource.modifiedWithinDays ?? "") : "";
  jobForm.elements.fileSourceSecure.checked = fileSource ? fileSource.secure : false;

  applyJobTypeVisibility(jobType);

  const scheduleSelect = document.getElementById("field-schedule-mode");
  const scheduleCustom = document.getElementById("field-schedule-custom");
  const scheduleValue = isEdit ? job.schedule : "daily";
  const everyNHoursMatch = EVERY_N_HOURS_PATTERN.exec(scheduleValue);
  const hourlyAllDayMatch = HOURLY_ALL_DAY_PATTERN.exec(scheduleValue);
  const hourWindowMatch = HOUR_WINDOW_PATTERN.exec(scheduleValue);
  const dailyMatch = DAILY_PATTERN.exec(scheduleValue);
  const weeklyMatch = WEEKLY_PATTERN.exec(scheduleValue);
  const monthlyMatch = MONTHLY_PATTERN.exec(scheduleValue);
  const weekdaysMatch = WEEKDAYS_PATTERN.exec(scheduleValue);

  resetWeekdayButtons();
  jobForm.elements.scheduleHours.value = 6;
  document.getElementById("field-weekdays-hour").value = 3;
  document.getElementById("field-daily-hour").value = 3;
  document.getElementById("field-weekly-day").value = "0";
  document.getElementById("field-weekly-hour").value = 3;
  document.getElementById("field-monthly-day").value = 1;
  document.getElementById("field-monthly-hour").value = 3;
  document.getElementById("field-hourly-start").value = 0;
  document.getElementById("field-hourly-end").value = 23;
  document.getElementById("field-everyn-start").value = 0;
  document.getElementById("field-everyn-end").value = 23;

  if (scheduleValue === "daily") {
    scheduleSelect.value = "daily";
  } else if (scheduleValue === "weekly") {
    scheduleSelect.value = "weekly";
  } else if (scheduleValue === "monthly") {
    scheduleSelect.value = "monthly";
  } else if (scheduleValue === "hourly") {
    scheduleSelect.value = "hourly";
  } else if (everyNHoursMatch) {
    scheduleSelect.value = "everyNHours";
    jobForm.elements.scheduleHours.value = everyNHoursMatch[1];
    setWeekdayButtonsFromCron(everyNHoursMatch[2]);
  } else if (hourlyAllDayMatch) {
    scheduleSelect.value = "hourly";
    setWeekdayButtonsFromCron(hourlyAllDayMatch[1]);
  } else if (hourWindowMatch) {
    const detected = detectHourWindow(hourWindowMatch[1].split(",").map(Number));
    if (detected && detected.step === 1) {
      scheduleSelect.value = "hourly";
      document.getElementById("field-hourly-start").value = detected.start;
      document.getElementById("field-hourly-end").value = detected.end;
      setWeekdayButtonsFromCron(hourWindowMatch[2]);
    } else if (detected) {
      scheduleSelect.value = "everyNHours";
      jobForm.elements.scheduleHours.value = detected.step;
      document.getElementById("field-everyn-start").value = detected.start;
      document.getElementById("field-everyn-end").value = detected.end;
      setWeekdayButtonsFromCron(hourWindowMatch[2]);
    } else {
      scheduleSelect.value = "custom";
    }
  } else if (dailyMatch) {
    scheduleSelect.value = "daily";
    document.getElementById("field-daily-hour").value = dailyMatch[1];
  } else if (weeklyMatch) {
    scheduleSelect.value = "weekly";
    document.getElementById("field-weekly-day").value = weeklyMatch[2];
    document.getElementById("field-weekly-hour").value = weeklyMatch[1];
  } else if (monthlyMatch) {
    scheduleSelect.value = "monthly";
    document.getElementById("field-monthly-day").value = monthlyMatch[2];
    document.getElementById("field-monthly-hour").value = monthlyMatch[1];
  } else if (weekdaysMatch) {
    scheduleSelect.value = "weekdays";
    document.getElementById("field-weekdays-hour").value = weekdaysMatch[1];
    setWeekdayButtons(weekdaysMatch[2].split(","));
  } else {
    scheduleSelect.value = "custom";
  }
  applyScheduleModeVisibility(scheduleSelect.value);
  scheduleCustom.value = scheduleSelect.value === "custom" ? scheduleValue : "";

  jobForm.elements.retentionDays.value = isEdit ? job.retentionDays : 7;
  jobForm.elements.gzip.checked = isEdit ? job.gzip : true;

  // Editar assume que a conexao ja salva funciona (nao forca re-teste so pra mudar a rotina,
  // por exemplo); qualquer edicao nos campos de conexao revoga isso via markConnectionUntested.
  // Criar sempre comeca sem testar.
  hideTestConnectionResults();
  setConnectionTested(isEdit);

  jobModalOverlay.hidden = false;
  (isEdit ? jobForm.elements.host : jobForm.elements.name).focus();
  updateSchedulePreview();
}

function closeJobModal() {
  jobModalOverlay.hidden = true;
}

jobForm.addEventListener("change", (e) => {
  if (CONNECTION_FIELD_NAMES.has(e.target.name)) markConnectionUntested();

  if (e.target.name === "dbMode") {
    document.getElementById("field-databases").disabled = e.target.value === "all";
  } else if (e.target.name === "scheduleMode") {
    applyScheduleModeVisibility(e.target.value);
    scheduleSchedulePreviewUpdate();
  } else if (e.target.name === "type") {
    applyJobTypeVisibility(e.target.value);
  } else if (e.target.name === "fileSourceProtocol") {
    applyFileProtocolVisibility(e.target.value);
  }
});

document.getElementById("field-weekday-picker-row").addEventListener("click", (e) => {
  const btn = e.target.closest(".weekday-btn");
  if (!btn) return;
  const pressed = btn.getAttribute("aria-pressed") === "true";
  btn.setAttribute("aria-pressed", pressed ? "false" : "true");
  scheduleSchedulePreviewUpdate();
});

function readHour(elementId, contextLabel) {
  const hour = Number(document.getElementById(elementId).value);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error(`Em "${contextLabel}", informe uma hora valida (0 a 23).`);
  }
  return hour;
}

function readWindow(startId, endId, contextLabel) {
  const start = Number(document.getElementById(startId).value);
  const end = Number(document.getElementById(endId).value);
  if (!Number.isInteger(start) || start < 0 || start > 23 || !Number.isInteger(end) || end < 0 || end > 23) {
    throw new Error(`Em "${contextLabel}", informe horarios validos (0 a 23) de inicio e fim.`);
  }
  return { start, end };
}

function buildScheduleFromForm() {
  const scheduleMode = jobForm.elements.scheduleMode.value;
  if (scheduleMode === "custom") return jobForm.elements.scheduleCustom.value.trim();
  if (scheduleMode === "hourly") {
    const { start, end } = readWindow("field-hourly-start", "field-hourly-end", "A cada hora");
    return buildIntervalSchedule(start, end, 1, readWeekdaysCron());
  }
  if (scheduleMode === "everyNHours") {
    const n = Number(jobForm.elements.scheduleHours.value);
    if (!Number.isInteger(n) || n < 1 || n > 23) {
      throw new Error('Em "A cada N horas", informe um numero inteiro de 1 a 23.');
    }
    const { start, end } = readWindow("field-everyn-start", "field-everyn-end", "A cada N horas");
    return buildIntervalSchedule(start, end, n, readWeekdaysCron());
  }
  if (scheduleMode === "weekdays") {
    const days = getSelectedWeekdays();
    if (days.length === 0) {
      throw new Error('Em "Dias especificos da semana", selecione ao menos um dia.');
    }
    const hour = readHour("field-weekdays-hour", "Dias especificos da semana");
    return `0 ${hour} * * ${days.join(",")}`;
  }
  if (scheduleMode === "daily") {
    return `0 ${readHour("field-daily-hour", "Diaria")} * * ${readWeekdaysCron()}`;
  }
  if (scheduleMode === "weekly") {
    const day = document.getElementById("field-weekly-day").value;
    return `0 ${readHour("field-weekly-hour", "Semanal")} * * ${day}`;
  }
  if (scheduleMode === "monthly") {
    const day = Number(document.getElementById("field-monthly-day").value);
    if (!Number.isInteger(day) || day < 1 || day > 31) {
      throw new Error('Em "Mensal", informe um dia do mes valido (1 a 31).');
    }
    return `0 ${readHour("field-monthly-hour", "Mensal")} ${day} * *`;
  }
  return scheduleMode;
}

function formatRunsPerDay(perDay) {
  if (perDay >= 1) return `~${perDay >= 10 ? Math.round(perDay) : Math.round(perDay * 10) / 10}x/dia`;
  const perWeek = perDay * 7;
  if (perWeek >= 1) return `~${Math.round(perWeek * 10) / 10}x/semana`;
  return `~${Math.round(perDay * 30 * 10) / 10}x/mes`;
}

const schedulePreviewEl = document.getElementById("schedule-preview");
let schedulePreviewTimer = null;
let schedulePreviewToken = 0;

function scheduleSchedulePreviewUpdate() {
  clearTimeout(schedulePreviewTimer);
  schedulePreviewTimer = setTimeout(updateSchedulePreview, 300);
}

async function updateSchedulePreview() {
  const token = ++schedulePreviewToken;
  let schedule;
  try {
    schedule = buildScheduleFromForm();
  } catch {
    schedulePreviewEl.hidden = true;
    return;
  }
  if (!schedule) {
    schedulePreviewEl.hidden = true;
    return;
  }

  const retentionDays = Number(jobForm.elements.retentionDays.value);
  let preview;
  try {
    preview = await apiFetch("/api/schedule/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schedule, retentionDays }),
    });
  } catch {
    schedulePreviewEl.hidden = true;
    return;
  }
  if (token !== schedulePreviewToken) return; // resposta velha, uma mais nova ja esta a caminho

  const parts = [];
  if (preview.runsPerDay) parts.push(formatRunsPerDay(preview.runsPerDay));
  if (preview.estimatedRetainedCount) {
    parts.push(
      `~${preview.estimatedRetainedCount} arquivo${preview.estimatedRetainedCount === 1 ? "" : "s"} retido${preview.estimatedRetainedCount === 1 ? "" : "s"}`,
    );
  }
  if (parts.length === 0) {
    schedulePreviewEl.hidden = true;
    return;
  }
  schedulePreviewEl.textContent = `Projecao: ${parts.join(" · ")}`;
  schedulePreviewEl.hidden = false;
}

jobForm.addEventListener("input", scheduleSchedulePreviewUpdate);

/** Campos de conexao (banco ou origem de arquivos), reaproveitados tanto no submit quanto no
 * botao "Testar conexao" — pra nao duplicar a leitura dos inputs em dois lugares. */
function buildConnectionFields(type) {
  const dbMode = jobForm.elements.dbMode.value;
  if (type === "files") {
    return {
      fileSourceProtocol: jobForm.elements.fileSourceProtocol.value,
      fileSourceHost: jobForm.elements.fileSourceHost.value.trim(),
      fileSourcePort: jobForm.elements.fileSourcePort.value,
      fileSourceUser: jobForm.elements.fileSourceUser.value.trim(),
      fileSourcePassword: jobForm.elements.fileSourcePassword.value,
      fileSourceRemoteDir: jobForm.elements.fileSourceRemoteDir.value.trim(),
      fileSourcePattern: jobForm.elements.fileSourcePattern.value.trim(),
      fileSourceNameContains: jobForm.elements.fileSourceNameContains.value.trim(),
      fileSourceModifiedWithinDays: jobForm.elements.fileSourceModifiedWithinDays.value,
      fileSourceSecure: jobForm.elements.fileSourceSecure.checked,
    };
  }
  return {
    host: jobForm.elements.host.value.trim(),
    port: jobForm.elements.port.value,
    user: jobForm.elements.user.value.trim(),
    password: jobForm.elements.password.value,
    databases: dbMode === "all" ? "all" : jobForm.elements.databases.value,
    gzip: jobForm.elements.gzip.checked,
  };
}

// Um botao "Testar conexao" por tipo (banco/arquivos), cada um logo apos os proprios campos de
// conexao — nao um so no fim do formulario, depois de varios campos de filtro que nada tem a ver
// com conectar (ficava dificil de achar). Os dois chamam a mesma logica.
document.querySelectorAll(".test-connection-btn").forEach((btn) => {
  const result = btn.nextElementSibling;
  btn.addEventListener("click", async () => {
    const type = jobForm.elements.type.value;
    hideTestConnectionResults();
    btn.disabled = true;
    btn.textContent = "Testando…";
    try {
      const payload = {
        type,
        existingJobName: jobForm.dataset.mode === "edit" ? jobForm.dataset.originalName : undefined,
        ...buildConnectionFields(type),
      };
      await apiFetch("/api/jobs/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      result.textContent = "✓ Conexao bem-sucedida.";
      result.className = "field-hint test-connection-result test-connection-ok";
      result.hidden = false;
      setConnectionTested(true);
    } catch (err) {
      result.textContent = "✗ " + err.message;
      result.className = "field-hint test-connection-result test-connection-error";
      result.hidden = false;
      setConnectionTested(false);
    } finally {
      btn.disabled = false;
      btn.textContent = "Testar conexao";
    }
  });
});

jobForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  jobFormError.hidden = true;

  // Defesa extra alem do botao "Salvar" desabilitado (ex: Enter no formulario) — sempre exige um
  // teste de conexao com sucesso antes de persistir qualquer credencial nova.
  if (jobForm.dataset.connectionTested !== "true") {
    jobFormError.textContent = 'Teste a conexao com sucesso antes de salvar ("Testar conexao").';
    jobFormError.hidden = false;
    return;
  }

  const mode = jobForm.dataset.mode;
  const originalName = jobForm.dataset.originalName;
  const type = jobForm.elements.type.value;

  let payload;
  try {
    payload = {
      name: jobForm.elements.name.value.trim(),
      type,
      schedule: buildScheduleFromForm(),
      retentionDays: jobForm.elements.retentionDays.value,
      ...buildConnectionFields(type),
    };
  } catch (err) {
    jobFormError.textContent = err.message;
    jobFormError.hidden = false;
    return;
  }

  const url = mode === "create" ? "/api/jobs" : `/api/jobs/${encodeURIComponent(originalName)}`;
  try {
    await apiFetch(url, {
      method: mode === "create" ? "POST" : "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    showToast(mode === "create" ? `Job "${payload.name}" criado.` : `Job "${originalName}" atualizado.`);
    closeJobModal();
    await loadJobs();
    await loadCronStatus();
  } catch (err) {
    jobFormError.textContent = err.message;
    jobFormError.hidden = false;
  }
});

document.querySelector('#job-modal-overlay [data-action="cancel"]').addEventListener("click", closeJobModal);
jobModalOverlay.addEventListener("click", (e) => {
  if (e.target === jobModalOverlay) closeJobModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!jobModalOverlay.hidden) closeJobModal();
  if (!detailModalOverlay.hidden) closeDetailModal();
  closeAllMenus();
});
document.addEventListener("click", (e) => {
  if (!e.target.closest(".card-menu")) closeAllMenus();
});
document.getElementById("new-job-menu").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;

  if (btn.dataset.action === "toggle-menu") {
    const menu = btn.nextElementSibling;
    const willOpen = menu.hidden;
    closeAllMenus();
    menu.hidden = !willOpen;
    return;
  }
  closeAllMenus();

  if (btn.dataset.action === "new-database") {
    openJobModal(null, "database");
  } else if (btn.dataset.action === "new-files") {
    openJobModal(null, "files");
  }
});

document.getElementById("cron-toggle-btn").addEventListener("click", async (e) => {
  const action = e.currentTarget.dataset.action;
  if (!action) return;
  if (action === "uninstall" && !confirm("Remover as entradas do isbackup do crontab?")) return;
  try {
    await apiFetch(`/api/cron/${action}`, { method: "POST" });
    showToast(action === "install" ? "Rotina instalada no cron." : "Rotina removida do cron.");
    await loadCronStatus();
  } catch (err) {
    showToast(err.message, true);
  }
});

// Abaixo de 1min pro proximo backup, o card pisca em amarelo — um aviso visual de "ta pra
// acontecer" mais chamativo que so o numero descendo.
const DUE_SOON_MS = 60 * 1000;

let tickInFlight = false;
function tickCountdowns() {
  const now = Date.now();
  let anyDue = false;

  document.querySelectorAll(".ring-center-label[data-next-run]").forEach((el) => {
    const diff = new Date(el.dataset.nextRun).getTime() - now;
    el.textContent = formatCountdown(diff);
    if (diff <= 0) anyDue = true;

    const wrap = el.closest(".next-run-ring-wrap");
    if (wrap) wrap.classList.toggle("due-soon", diff > 0 && diff <= DUE_SOON_MS);
  });
  document.querySelectorAll(".ring-progress[data-next-run]").forEach((circle) => {
    updateRingProgress(circle, now);
  });

  if (anyDue && !tickInFlight) {
    tickInFlight = true;
    loadJobs().finally(() => {
      tickInFlight = false;
    });
  }
}
setInterval(tickCountdowns, 1000);

loadJobs();
loadCronStatus();

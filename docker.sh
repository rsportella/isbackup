#!/usr/bin/env bash
# Sobe o isbackup no Docker e abre o painel no navegador.
#
# Uso:
#   ./docker.sh               # sobe (na 1a vez pergunta onde guardar os dados) e abre o navegador
#   ./docker.sh setup         # pergunta de novo onde guardar os dados (e sobe)
#   ./docker.sh --no-open     # sobe sem abrir o navegador
#   ./docker.sh logs          # acompanha os logs do container
#   ./docker.sh down          # para o container (os dados ficam)
#
# Porta: ISBACKUP_PORT=9000 ./docker.sh     Fuso: TZ=America/Recife ./docker.sh
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
PROJECT_DIR="$(pwd)"
# Escolhas desta maquina (pasta dos dados). Fica fora do git.
LOCAL_CONF="docker.local.env"

if ! command -v docker >/dev/null 2>&1; then
  echo "Erro: docker nao encontrado. Instale o Docker Desktop: https://www.docker.com/products/docker-desktop/" >&2
  exit 1
fi

# Prefere o Docker Desktop quando ele esta instalado e aberto, mesmo que o contexto padrao do
# docker seja outro (ex: Colima). Pra usar outro motor de proposito: DOCKER_CONTEXT=colima ./docker.sh
if [ -z "${DOCKER_CONTEXT:-}" ] && docker context inspect desktop-linux >/dev/null 2>&1 \
  && docker --context desktop-linux info >/dev/null 2>&1; then
  export DOCKER_CONTEXT=desktop-linux
  echo "Usando o Docker Desktop."
fi

if ! docker info >/dev/null 2>&1; then
  echo "Erro: o Docker nao esta respondendo. Abra o Docker Desktop e tente de novo." >&2
  exit 1
fi

compose() {
  # --env-file: usa so as escolhas desta maquina (e nao o .env do app, que guarda a chave das senhas).
  if [ -f "$LOCAL_CONF" ]; then docker compose --env-file "$LOCAL_CONF" "$@"; else docker compose "$@"; fi
}

case "${1:-}" in
  down | stop) compose down; exit 0 ;;
  logs) compose logs -f; exit 0 ;;
esac

interactive=0
[ -t 0 ] && [ -t 1 ] && interactive=1

ask() { # ask "pergunta" "padrao" -> resposta (ou o padrao sem terminal)
  local answer=""
  if [ "$interactive" = 1 ]; then read -r -p "$1" answer || true; fi
  echo "${answer:-$2}"
}

is_yes() { case "$1" in [sS]* | [yY]*) return 0 ;; *) return 1 ;; esac; }

expand_path() { # ~ e caminhos relativos -> absolutos
  local p="$1"
  case "$p" in "~") p="$HOME" ;; "~/"*) p="$HOME/${p#\~/}" ;; esac
  case "$p" in /*) ;; *) p="$PROJECT_DIR/$p" ;; esac
  mkdir -p "$p"
  (cd "$p" && pwd)
}

native_cron_lines() { crontab -l 2>/dev/null | grep -c '# isbackup:' || true; }

MIGRATE_CRON=0
setup() {
  local data=""
  echo
  echo "== Onde guardar os dados do isbackup no Docker? =="
  echo "   (config.yaml, a chave das senhas e os backups ficam nessa pasta do seu computador)"

  # Dados de uma instalacao direta (./run.sh) nesta pasta: oferece usar os mesmos.
  local native_jobs=0
  [ -f config.yaml ] && native_jobs="$(grep -c '^  - name:' config.yaml || true)"
  if [ "$native_jobs" -gt 0 ]; then
    local size; size="$(du -sh backups 2>/dev/null | cut -f1 || echo "0")"
    echo
    echo "Encontrei os dados da instalacao direta aqui: $native_jobs job(s) e ${size:-0} de backups em ./backups."
    if is_yes "$(ask "Usar esses mesmos dados no Docker? [S/n] " s)"; then
      data="$PROJECT_DIR"
    fi
  fi

  if [ -z "$data" ]; then
    data="$(ask "Pasta para os dados [$PROJECT_DIR/docker-data]: " "$PROJECT_DIR/docker-data")"
  fi
  data="$(expand_path "$data")"
  printf '# Gerado pelo ./docker.sh setup (escolhas desta maquina; fora do git)\nISBACKUP_DATA=%s\n' "$data" > "$LOCAL_CONF"
  echo "Dados do Docker em: $data   (backups em $data/backups)"

  # Mesmos dados da instalacao direta + rotinas ainda no crontab do Mac = cada backup rodaria duas
  # vezes (no Mac e no container), disputando os mesmos arquivos.
  if [ "$data" = "$PROJECT_DIR" ] && [ "$(native_cron_lines)" -gt 0 ]; then
    echo
    echo "As rotinas da instalacao direta ainda estao no crontab do seu computador."
    echo "Se ficarem nos dois lugares, cada backup roda duas vezes."
    # Sem terminal pra perguntar, o padrao e NAO mexer no crontab.
    local default_migrate=n
    [ "$interactive" = 1 ] && default_migrate=s
    if is_yes "$(ask "Passar as rotinas para o Docker? (remove do computador e instala no container) [S/n] " "$default_migrate")"; then
      MIGRATE_CRON=1
    else
      echo "Ok, nada mudou no crontab. Lembre de instalar as rotinas em um lugar so."
    fi
  fi
  echo
}

if [ "${1:-}" = "setup" ] || [ ! -f "$LOCAL_CONF" ]; then
  setup
fi

if pgrep -f "dist/cli.js ui" >/dev/null 2>&1; then
  echo "Aviso: o painel da instalacao direta (./run.sh) esta aberto neste computador. Se ele usa os"
  echo "       mesmos dados, feche-o (Ctrl+C) para os dois nao dispararem backups ao mesmo tempo."
fi

open_browser=1
for arg in "$@"; do
  [ "$arg" = "--no-open" ] && open_browser=0
done

# --build: sempre sobe com o codigo atual (depois de um "git pull", por exemplo). Com cache, leva
# poucos segundos quando nada mudou.
compose up -d --build

PORT="${ISBACKUP_PORT:-8787}"
URL="http://localhost:$PORT"

printf "Esperando o painel responder"
ready=0
for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null "$URL/api/cron/status" 2>/dev/null; then ready=1; break; fi
  printf "."
  sleep 1
done
echo
if [ "$ready" != 1 ]; then
  echo "O painel nao respondeu em 60s. Veja os logs com: ./docker.sh logs" >&2
  exit 1
fi

if [ "$MIGRATE_CRON" = 1 ]; then
  # Remove so o bloco do isbackup do crontab do computador (o resto do crontab fica intacto)...
  # Le o crontab inteiro ANTES de gravar: ler e regravar no mesmo pipeline pode truncar o arquivo
  # no meio da leitura e apagar as outras linhas do usuario.
  current_crontab="$(crontab -l 2>/dev/null || true)"
  backup_file="$(mktemp -t isbackup-crontab-antes)"
  printf '%s\n' "$current_crontab" > "$backup_file"
  printf '%s\n' "$current_crontab" \
    | sed '/^# >>> isbackup managed jobs/,/^# <<< isbackup managed jobs <<</d' \
    | crontab -
  echo "Copia do crontab anterior do computador: $backup_file"
  # ...e instala as mesmas rotinas dentro do container.
  compose exec -T isbackup isbackup cron install
  echo "Rotinas passadas para o Docker."
fi

echo "Painel: $URL"
if [ "$open_browser" = 1 ]; then
  case "$(uname -s)" in
    Darwin) open "$URL" ;;
    Linux) { command -v xdg-open >/dev/null 2>&1 && xdg-open "$URL" >/dev/null 2>&1; } || true ;;
  esac
fi

#!/usr/bin/env bash
# Sobe a interface web do isbackup (http://127.0.0.1:8787 por padrao).
#
# Uso:
#   ./run.sh                 # porta 8787
#   ./run.sh --port 9000     # porta customizada (repassa os argumentos pro "isbackup ui")
#   ./run.sh --no-open       # nao abre o navegador sozinho
#
# Sempre recompila antes de subir e, se ja houver um isbackup rodando na mesma porta,
# encerra o antigo — senao ele continuaria servindo o codigo velho (mudancas em src/*.ts so
# valem depois de build + restart).
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

PORT=8787
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  case "${args[i]}" in
    -p | --port) PORT="${args[i + 1]:-$PORT}" ;;
    --port=*) PORT="${args[i]#--port=}" ;;
  esac
done

if ! command -v node >/dev/null 2>&1; then
  echo "Erro: node nao encontrado no PATH. Instale com: brew install node" >&2
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Instalando dependencias..."
  npm install
fi

echo "Compilando..."
npm run build --silent

# Primeiro uso (clone novo): comeca com um config.yaml sem jobs — a interface abre na tela vazia,
# com o botao "Novo job". O .env (chave que cifra as senhas) e criado sozinho no primeiro job.
# So vale pro config padrao; com --config <outro>, o arquivo indicado precisa existir.
if [ ! -f config.yaml ] && [[ " $* " != *" --config "* && " $* " != *" -c "* && " $* " != *" --config="* ]]; then
  echo "Primeiro uso: criando config.yaml vazio (crie os jobs pela interface)."
  (umask 077 && printf 'defaults:\n  outputDir: ./backups\n  retentionDays: 7\n\njobs: []\n' > config.yaml)
fi

# Encerra uma instancia anterior do isbackup na mesma porta (so se for mesmo o isbackup).
old_pid="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -n1 || true)"
if [ -n "$old_pid" ]; then
  if ps -p "$old_pid" -o command= | grep -q "dist/cli.js ui"; then
    echo "Encerrando isbackup anterior (PID $old_pid)..."
    kill "$old_pid"
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 "$old_pid" 2>/dev/null || break
      sleep 0.3
    done
  else
    echo "Erro: a porta $PORT ja esta em uso por outro programa (PID $old_pid). Use --port <outra>." >&2
    exit 1
  fi
fi

# Abre o painel no navegador assim que o servidor estiver no ar, a menos que --no-open seja passado
# (ele e consumido aqui; o resto dos argumentos vai pro "isbackup ui").
ui_args=()
open_browser=1
for arg in "$@"; do
  if [ "$arg" = "--no-open" ]; then open_browser=0; else ui_args+=("$arg"); fi
done
[ "$open_browser" = 1 ] && ui_args+=("--open")

echo "Iniciando isbackup em http://127.0.0.1:$PORT (Ctrl+C para parar)..."
exec node dist/cli.js ui ${ui_args[@]+"${ui_args[@]}"}

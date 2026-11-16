#!/bin/sh
# Prepara o container e sobe o comando pedido (por padrao, o painel web).
set -e

DATA="${ISBACKUP_HOME:-/data}"
mkdir -p "$DATA"

# Fuso horario: o cron agenda e o painel calcula "proximo backup" no horario local.
if [ -n "$TZ" ] && [ -f "/usr/share/zoneinfo/$TZ" ]; then
  ln -sf "/usr/share/zoneinfo/$TZ" /etc/localtime
  echo "$TZ" > /etc/timezone
fi

# Primeiro uso: config.yaml sem jobs — o painel abre na tela vazia, com o botao "Novo job".
# O .env (chave que cifra as senhas) e criado sozinho quando o primeiro job e salvo.
if [ ! -f "$DATA/config.yaml" ]; then
  echo "Primeiro uso: criando $DATA/config.yaml vazio (crie os jobs pelo painel)."
  (umask 077 && printf 'defaults:\n  outputDir: ./backups\n  retentionDays: 7\n\njobs: []\n' > "$DATA/config.yaml")
fi

# Daemon do cron em segundo plano: roda as rotinas instaladas pelo painel ("Instalar rotina no
# cron"). O crontab fica num volume proprio, entao sobrevive a recriacao do container.
cron

exec "$@"

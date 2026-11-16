#!/bin/sh
# Atalho pra CLI dentro do container: docker compose exec isbackup isbackup list
exec node /app/dist/cli.js "$@"

# syntax=docker/dockerfile:1

# ---- build: compila o TypeScript e separa so as dependencias de producao ------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- runtime ---------------------------------------------------------------------------------
FROM node:22-bookworm-slim

# cron: agenda os backups dentro do container (o mesmo crontab que "Instalar rotina no cron" usa)
# default-mysql-client: mysqldump/mysql (cliente do MariaDB, compativel com MySQL e MariaDB)
# tzdata: o horario das rotinas segue a variavel TZ
RUN apt-get update \
 && apt-get install -y --no-install-recommends cron default-mysql-client tzdata ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production \
    ISBACKUP_HOME=/data \
    TZ=America/Sao_Paulo \
    ISBACKUP_DOCKER=1

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json config.example.yaml .env.example ./
COPY public ./public
COPY docker/entrypoint.sh /usr/local/bin/isbackup-entrypoint
COPY docker/isbackup.sh /usr/local/bin/isbackup
RUN chmod 755 /usr/local/bin/isbackup-entrypoint /usr/local/bin/isbackup

# Tudo que muda fica aqui: config.yaml, .env (chave das senhas), backups/ e logs/
VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/cron/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["isbackup-entrypoint"]
# Dentro do container escuta em todas as interfaces; quem limita o acesso e a publicacao da porta
# (no compose.yaml, so em 127.0.0.1 do seu computador).
CMD ["isbackup", "ui", "--host", "0.0.0.0", "--port", "8787"]

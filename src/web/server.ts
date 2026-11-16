import path from "node:path";
import express, { type Express } from "express";
import { createApiRouter, type ApiOptions } from "./api.js";
import { localOnly } from "./local-only.js";

export function createApp(opts: ApiOptions): Express {
  const app = express();
  app.disable("x-powered-by");
  // Antes de tudo (inclusive dos arquivos do painel): so a propria maquina, pelo proprio painel.
  app.use(localOnly());
  app.use(express.json());
  app.use("/api", createApiRouter(opts));
  app.use(express.static(path.join(opts.projectRoot, "public")));
  return app;
}

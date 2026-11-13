import path from "node:path";
import express, { type Express } from "express";
import { createApiRouter, type ApiOptions } from "./api.js";

export function createApp(opts: ApiOptions): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json());
  app.use("/api", createApiRouter(opts));
  app.use(express.static(path.join(opts.projectRoot, "public")));
  return app;
}

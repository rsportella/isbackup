import type { NextFunction, Request, Response } from "express";

/**
 * Protecao do painel, que nao tem login: so a propria maquina, pelo proprio painel, pode usa-lo.
 *
 * Escutar so em 127.0.0.1 NAO basta. Sem estas checagens, qualquer site aberto no navegador da
 * pessoa conseguia:
 *  - via DNS rebinding (o dominio do atacante passa a apontar pra 127.0.0.1), ler a API como se
 *    fosse a mesma origem: lista de jobs (hosts, usuarios, bancos) e o DOWNLOAD dos backups;
 *  - mesmo sem isso, disparar acoes com um POST "simples" (sem pre-verificacao do navegador):
 *    rodar/parar backups, pausar jobs, remover as rotinas do cron.
 *
 * Defesas:
 *  1. Host: o pedido precisa ser enderecado a 127.0.0.1 / localhost / [::1]. No DNS rebinding o
 *     navegador manda o dominio do atacante no Host, entao e recusado.
 *  2. Sec-Fetch-Site (navegadores atuais): pedidos da API vindos de outro site sao recusados.
 *  3. Origin: acoes (POST/PUT/PATCH/DELETE) com Origin diferente da do proprio painel sao
 *     recusadas (cobre navegadores sem Sec-Fetch-*).
 * Pedidos sem esses cabecalhos de navegador (curl, a CLI, o healthcheck do Docker) continuam
 * funcionando — eles ja estao na propria maquina.
 */

const LOCAL_HOSTNAMES = ["127.0.0.1", "localhost", "[::1]"];
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const TRUSTED_FETCH_SITES = new Set(["same-origin", "none"]);

function hostnameOf(hostHeader: string): string | null {
  try {
    return new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Hosts aceitos: os locais + os de ISBACKUP_ALLOWED_HOSTS (lista separada por virgula). */
export function allowedHostnames(extra = process.env.ISBACKUP_ALLOWED_HOSTS ?? ""): Set<string> {
  const names = extra
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return new Set([...LOCAL_HOSTNAMES, ...names]);
}

function deny(res: Response, message: string): void {
  res.status(403).json({ error: message });
}

export function localOnly() {
  const allowed = allowedHostnames();

  return (req: Request, res: Response, next: NextFunction): void => {
    const host = req.headers.host ?? "";
    const hostname = hostnameOf(host);
    if (!hostname || !allowed.has(hostname)) {
      deny(res, "Acesso negado: o painel do isbackup so atende em http://127.0.0.1 ou http://localhost.");
      return;
    }

    const isApi = req.path.startsWith("/api/") || req.path === "/api";
    const fetchSite = req.headers["sec-fetch-site"];
    if (isApi && typeof fetchSite === "string" && !TRUSTED_FETCH_SITES.has(fetchSite)) {
      deny(res, "Acesso negado: pedido vindo de outro site.");
      return;
    }

    if (!SAFE_METHODS.has(req.method)) {
      const origin = req.headers.origin;
      if (origin !== undefined) {
        let sameOrigin = false;
        try {
          const o = new URL(origin);
          sameOrigin = o.protocol === "http:" && o.host.toLowerCase() === host.toLowerCase();
        } catch {
          sameOrigin = false; // "null" (iframe sandbox, arquivo local) ou lixo
        }
        if (!sameOrigin) {
          deny(res, "Acesso negado: acao vinda de outro site.");
          return;
        }
      }
    }

    next();
  };
}

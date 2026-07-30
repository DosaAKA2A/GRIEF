// Nucleo del servidor de la UI: sirve src/ui en 127.0.0.1 y transmite el
// estado combinado (Valorant + LoL + Dota 2) por SSE. Lo consumen server.js
// (CLI) y la app de escritorio (electron/main.js).
import http from "node:http";
import { readFile } from "node:fs/promises";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { MultiTracker } from "./games.js";

const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), "ui");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
};

export function startServer({ port = 4327 } = {}) {
  let state = {
    game: null, gameLabel: null,
    status: "Arrancando...", phase: null, label: null, rows: [], updatedAt: null,
  };
  const clients = new Set();

  function broadcast() {
    const data = `data: ${JSON.stringify(state)}\n\n`;
    for (const res of clients) res.write(data);
  }

  const tracker = new MultiTracker();
  tracker.on("update", (s) => {
    state = s;
    broadcast();
  });

  const server = http.createServer(async (req, res) => {
    const path = req.url.split("?")[0];
    if (path === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify(state)}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    const file = path === "/" ? "index.html" : path.slice(1);
    try {
      if (file.includes("..")) throw new Error("fuera de ui/");
      const body = await readFile(join(UI_DIR, file));
      res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("No existe");
    }
  });

  // Latido SSE para que proxies/navegadores no corten la conexion por inactividad.
  setInterval(() => {
    for (const res of clients) res.write(": ping\n\n");
  }, 25000).unref();

  // Receptor GSI de Dota 2 en puerto fijo (4328): el juego postea su estado
  // aqui segun el cfg gamestate_integration_grief.cfg. Si otro proceso GRIEF
  // ya lo tiene abierto, se omite sin romper nada.
  const gsi = http.createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405);
      res.end();
      return;
    }
    let cuerpo = "";
    req.on("data", (c) => (cuerpo += c));
    req.on("end", () => {
      try {
        tracker.gsiDota(JSON.parse(cuerpo));
      } catch {
        // payload raro: ignorar
      }
      res.writeHead(200);
      res.end();
    });
  });
  gsi.on("error", (err) => {
    if (err.code === "EADDRINUSE") console.log("GSI 4328 en uso por otra instancia de GRIEF; se omite.");
    else console.error("GSI:", err.message);
  });
  gsi.listen(4328, "127.0.0.1");

  tracker.start(); // los errores por juego los maneja cada tracker hijo

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () =>
      resolve({ url: `http://127.0.0.1:${port}`, server, tracker })
    );
  });
}

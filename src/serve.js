// Nucleo del servidor de la UI: sirve src/ui en 127.0.0.1 y transmite el
// estado combinado (Valorant + LoL + Dota 2) por SSE. Lo consumen server.js
// (CLI) y la app de escritorio (electron/main.js).
import http from "node:http";
import { readFile } from "node:fs/promises";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { MultiTracker } from "./games.js";
import * as dota from "./dota.js";

const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), "ui");

// Version propia (para que la UI compare contra la ultima release publicada).
let VERSION = "0.0.0";
try {
  const pkg = JSON.parse(await readFile(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"));
  VERSION = pkg.version ?? VERSION;
} catch {}

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
  let ultimoJson = null;

  // Solo difunde estados realmente distintos (updatedAt fuera de la firma:
  // cambia solo y provocaria repintados identicos en la UI).
  function broadcast() {
    if (!clients.size) return;
    const { updatedAt, ...resto } = state;
    const firma = JSON.stringify(resto);
    if (firma === ultimoJson) return;
    ultimoJson = firma;
    const data = `data: ${JSON.stringify(state)}\n\n`;
    for (const res of clients) res.write(data);
  }

  const tracker = new MultiTracker();
  tracker.on("update", (s) => {
    state = s;
    broadcast();
  });

  // Cuerpo JSON de las acciones de perfiles. Tope corto: aqui solo viajan
  // nombres e identificadores, nunca archivos.
  function leerJson(req) {
    return new Promise((resolve, reject) => {
      let datos = "";
      req.on("data", (c) => {
        datos += c;
        if (datos.length > 8192) reject(new Error("cuerpo demasiado grande"));
      });
      req.on("end", () => {
        try {
          resolve(datos ? JSON.parse(datos) : {});
        } catch {
          reject(new Error("json invalido"));
        }
      });
      req.on("error", reject);
    });
  }

  const server = http.createServer(async (req, res) => {
    const path = req.url.split("?")[0];
    // Perfiles de controles de Dota 2: leen y escriben en el arbol de Steam de
    // esta computadora, por eso viven aqui y no en la UI.
    if (path.startsWith("/dota/")) {
      const accion = path.slice("/dota/".length);
      try {
        let salida;
        if (accion === "estado") {
          salida = await dota.estado();
        } else if (req.method !== "POST") {
          throw new Error("metodo no permitido");
        } else if (accion === "guardar") {
          salida = await dota.guardarPerfil(await leerJson(req));
        } else if (accion === "aplicar") {
          salida = await dota.aplicarPerfil(await leerJson(req));
        } else if (accion === "borrar") {
          salida = await dota.borrarPerfil(await leerJson(req));
        } else if (accion === "reiniciar-steam") {
          salida = await dota.reiniciarSteam();
        } else {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "No existe" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(salida));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }
    if (path === "/version") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ version: VERSION }));
      return;
    }
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

  tracker.start(); // los errores por juego los maneja cada tracker hijo

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () =>
      resolve({ url: `http://127.0.0.1:${port}`, server, tracker })
    );
  });
}

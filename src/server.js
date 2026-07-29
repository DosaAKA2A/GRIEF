// Servidor de la UI: sirve src/ui en 127.0.0.1 y transmite el estado del
// Tracker por SSE. Pensado para dejarlo abierto en la segunda pantalla.
// Uso:  node src/server.js [--port 4327] [--no-open]
import http from "node:http";
import { readFile } from "node:fs/promises";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Tracker } from "./tracker.js";

const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), "ui");
const portArg = process.argv.indexOf("--port");
const PORT = portArg !== -1 ? Number(process.argv[portArg + 1]) : 4327;
const OPEN = !process.argv.includes("--no-open");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

const state = { status: "Arrancando...", phase: null, label: null, rows: [], updatedAt: null };
const clients = new Set();

function broadcast() {
  const data = `data: ${JSON.stringify(state)}\n\n`;
  for (const res of clients) res.write(data);
}

const tracker = new Tracker({ watch: true });
tracker.on("status", (s) => {
  state.status = s;
  broadcast();
});
tracker.on("match", (m) => {
  state.phase = m.phase;
  state.label = m.label;
  state.rows = m.rows;
  state.updatedAt = Date.now();
  broadcast();
});
tracker.on("no-match", () => {
  state.phase = null;
  state.label = null;
  state.rows = [];
  state.updatedAt = Date.now();
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

server.listen(PORT, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`UI del tracker en ${url}`);
  if (OPEN) spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
});

// Latido SSE para que proxies/navegadores no corten la conexion por inactividad.
setInterval(() => {
  for (const res of clients) res.write(": ping\n\n");
}, 25000).unref();

tracker.start().catch((err) => {
  console.error("Error del tracker:", err.message);
  process.exit(1);
});

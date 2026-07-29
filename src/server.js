// CLI del servidor de la UI (la app de escritorio usa electron/main.js).
// Uso:  node src/server.js [--port 4327] [--no-open]
import { spawn } from "node:child_process";
import { startServer } from "./serve.js";

const portArg = process.argv.indexOf("--port");
const PORT = portArg !== -1 ? Number(process.argv[portArg + 1]) : 4327;
const OPEN = !process.argv.includes("--no-open");

const { url } = await startServer({ port: PORT });
console.log(`UI del tracker en ${url}`);
if (OPEN) spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();

// Configurador automatico de Dota 2:
//  1) Instala el cfg de GSI (oficial de Valve) en la carpeta del juego —
//     siempre que falte, sin condiciones.
//  2) Anade "-console -condebug" a las opciones de lanzamiento (localconfig
//     .vdf de Steam) — SOLO con Steam cerrado, porque Steam sobreescribe ese
//     archivo al salir. Con Steam abierto, avisa y lo reintenta al arrancar.
import { readFile, writeFile, copyFile, mkdir, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join } from "node:path";

const GSI_CFG = `"GRIEF"
{
  "uri" "http://127.0.0.1:4328/"
  "timeout" "5.0"
  "buffer" "0.1"
  "throttle" "0.5"
  "heartbeat" "10.0"
  "data"
  {
    "provider" "1"
    "map" "1"
    "player" "1"
    "hero" "1"
  }
}
`;

const FLAGS = ["-console", "-condebug"];

function regQuery(clave, valor) {
  return new Promise((resolve) => {
    execFile("reg", ["query", clave, "/v", valor], (err, out) => {
      if (err) return resolve(null);
      const m = /REG_SZ\s+(.+)/.exec(out);
      resolve(m ? m[1].trim() : null);
    });
  });
}

function steamAbierto() {
  return new Promise((resolve) => {
    execFile("tasklist", ["/FI", "IMAGENAME eq steam.exe", "/NH"], (err, out) => {
      resolve(!err && /steam\.exe/i.test(out ?? ""));
    });
  });
}

async function existe(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function rutaSteam() {
  const p = await regQuery("HKCU\\Software\\Valve\\Steam", "SteamPath");
  return p ? p.replace(/\//g, "\\") : null;
}

// Instalacion real de Dota: la biblioteca cuyo appmanifest_570.acf existe.
export async function rutaDota(steam) {
  let bibliotecas = [steam];
  try {
    const vdf = await readFile(join(steam, "steamapps", "libraryfolders.vdf"), "utf8");
    for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) {
      bibliotecas.push(m[1].replace(/\\\\/g, "\\"));
    }
  } catch {}
  for (const lib of [...new Set(bibliotecas)]) {
    if (await existe(join(lib, "steamapps", "appmanifest_570.acf"))) {
      return join(lib, "steamapps", "common", "dota 2 beta");
    }
  }
  return null;
}

async function instalarGsi(dota) {
  const dir = join(dota, "game", "dota", "cfg", "gamestate_integration");
  const destino = join(dir, "gamestate_integration_grief.cfg");
  if (await existe(destino)) return false;
  await mkdir(dir, { recursive: true });
  await writeFile(destino, GSI_CFG, "utf8");
  return true;
}

// Anade los flags al bloque "570" de cada localconfig.vdf que lo tenga.
async function ponerLaunchOptions(steam) {
  const { readdir } = await import("node:fs/promises");
  let tocados = 0;
  let usuarios = [];
  try {
    usuarios = await readdir(join(steam, "userdata"));
  } catch {
    return 0;
  }
  for (const u of usuarios) {
    const lc = join(steam, "userdata", u, "config", "localconfig.vdf");
    if (!(await existe(lc))) continue;
    let txt = await readFile(lc, "utf8");
    const bloque = /("570"\s*\{)([\s\S]*?)(\n\s*\})/m.exec(txt);
    if (!bloque) continue; // esa cuenta nunca abrio Dota
    const opciones = /"LaunchOptions"\s+"([^"]*)"/.exec(bloque[2]);
    const actuales = opciones ? opciones[1] : "";
    const faltan = FLAGS.filter((f) => !actuales.includes(f));
    if (!faltan.length) continue;
    const nuevas = (actuales + " " + faltan.join(" ")).trim();
    let bloqueNuevo;
    if (opciones) {
      bloqueNuevo = bloque[0].replace(/("LaunchOptions"\s+")[^"]*(")/, `$1${nuevas}$2`);
    } else {
      bloqueNuevo = bloque[1] + `\n\t\t\t\t\t\t"LaunchOptions"\t\t"${nuevas}"` + bloque[2] + bloque[3];
    }
    await copyFile(lc, lc + ".grief.bak"); // respaldo antes de tocar nada
    txt = txt.replace(bloque[0], bloqueNuevo);
    await writeFile(lc, txt, "utf8");
    tocados++;
  }
  return tocados;
}

// Solo el GSI (siempre seguro, no toca Steam): para el arranque de la app.
export async function instalarGsiSiFalta() {
  const steam = await rutaSteam();
  if (!steam) return null;
  const dota = await rutaDota(steam);
  if (!dota) return null;
  const nuevo = await instalarGsi(dota).catch(() => false);
  return nuevo ? "Dota 2: GSI de GRIEF instalado en el juego." : null;
}

// Punto de entrada completo: devuelve un texto de estado para el usuario.
export async function configurarDota() {
  const steam = await rutaSteam();
  if (!steam) return null; // sin Steam: nada que hacer
  const dota = await rutaDota(steam);
  if (!dota) return null; // sin Dota instalado
  const gsiNuevo = await instalarGsi(dota).catch(() => false);
  const abierto = await steamAbierto();
  if (abierto) {
    return gsiNuevo
      ? "Dota 2: GSI instalado. Falta -condebug: cierra Steam del todo y reabre GRIEF (o espera al proximo arranque)."
      : null;
  }
  const tocados = await ponerLaunchOptions(steam).catch(() => 0);
  if (tocados > 0) return `Dota 2: configurado (-console -condebug en ${tocados} cuenta(s) de Steam, con respaldo .grief.bak).`;
  return gsiNuevo ? "Dota 2: GSI instalado." : "Dota 2: ya estaba configurado.";
}

// Uso directo:  npm run configurar-dota  (con Steam cerrado)
if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/")}`) {
  const r = await configurarDota();
  console.log(r ?? "Nada que hacer (¿Steam o Dota no encontrados?)");
}

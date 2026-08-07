// Perfiles de controles de Dota 2: guardar la configuracion tal como esta
// ahora y volver a ponerla en cualquier cuenta de Steam de esta computadora.
//
// Dota guarda los controles fuera del juego, en el arbol por usuario de Steam:
//   userdata\<steamid3>\570\remote\  -> se sincroniza con Steam Cloud
//   userdata\<steamid3>\570\local\   -> solo esta maquina
// Un "perfil" aqui es una copia de esos archivos. Como no llevan nada atado a
// la cuenta, la copia de una cuenta sirve tal cual en otra.
import { execFile } from "node:child_process";
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { promisify } from "node:util";

const ejecutar = promisify(execFile);
const APPID = "570";

// Archivos que forman un perfil, relativos a userdata\<id>\570\. Solo
// configuracion: nada de estadisticas, ultima partida ni logos de equipo, que
// cambian cada rato y no son parte de "como juego".
const ARCHIVOS = [
  "remote/cfg/dotakeys_personal.lst", // el layout de controles completo
  "remote/cfg/herobuilds.cfg", // guias de objetos propias
  "remote/cfg/hero_facet_config.cfg",
  "remote/cfg/dota_player_loadout_shuffle.txt", // rotacion de objetos globales
  "remote/cfg/saved_sets.kv", // sets guardados por heroe
  "remote/cfg/dota_armory_filters.txt",
  "remote/user_keys.vcfg", // binds hechos por consola
  "remote/user_convars.vcfg", // ajustes de juego
  "remote/scripts/control_groups.txt", // grupos de control por heroe
  "remote/scripts/item_suggest_preference.txt",
  "remote/scripts/lobby_settings.txt",
  "local/cfg/user_convars_0_slot0.vcfg",
  "local/cfg/user_keys_0_slot0.vcfg",
];

// Raiz de los perfiles guardados. Fuera del repo y fuera de Steam: sobrevive a
// reinstalaciones del juego y a las actualizaciones de la app.
export const RAIZ = join(process.env.APPDATA ?? join(homedir(), ".config"), "GRIEF", "dota-perfiles");

function steamPath() {
  // El registro es la fuente fiable; la ruta clasica es solo el respaldo.
  const candidatos = [
    process.env.ProgramFiles ? join(process.env.ProgramFiles, "Steam") : null,
    process.env["ProgramFiles(x86)"] ? join(process.env["ProgramFiles(x86)"], "Steam") : null,
    "C:\\Program Files (x86)\\Steam",
  ].filter(Boolean);
  return candidatos.find((p) => existsSync(join(p, "userdata"))) ?? null;
}

async function steamPathRegistro() {
  try {
    const { stdout } = await ejecutar("reg", ["query", "HKCU\\Software\\Valve\\Steam", "/v", "SteamPath"]);
    const m = stdout.match(/SteamPath\s+REG_SZ\s+(.+)/i);
    if (m) {
      const ruta = m[1].trim().replace(/\//g, "\\");
      if (existsSync(join(ruta, "userdata"))) return ruta;
    }
  } catch {}
  return steamPath();
}

// El nombre visible de la cuenta esta en su localconfig.vdf.
async function personaDe(dirUsuario) {
  try {
    const vdf = await readFile(join(dirUsuario, "config", "localconfig.vdf"), "utf8");
    const m = vdf.match(/"PersonaName"\s+"([^"]+)"/);
    if (m) return m[1];
  } catch {}
  return null;
}

// last_match.dat es KeyValues binario: el id va como uint64 LE justo despues
// de la clave "last_match_id\0". Sirve para saber con que controles se jugo.
async function ultimaPartida(appDir) {
  try {
    const buf = await readFile(join(appDir, "remote", "cfg", "last_match.dat"));
    const clave = Buffer.from("last_match_id\0", "ascii");
    const i = buf.indexOf(clave);
    if (i < 0 || i + clave.length + 8 > buf.length) return null;
    const id = buf.readBigUInt64LE(i + clave.length);
    return id > 0n ? id.toString() : null;
  } catch {
    return null;
  }
}

// Nombre del layout tal como lo llama el propio Dota (campo "Name" del .lst).
async function nombreLayout(rutaLst) {
  try {
    const texto = await readFile(rutaLst, "utf8");
    const m = texto.match(/^\s*"Name"\s+"([^"]*)"/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export async function listarCuentas() {
  const steam = await steamPathRegistro();
  if (!steam) return [];
  const userdata = join(steam, "userdata");
  let dirs = [];
  try {
    dirs = await readdir(userdata, { withFileTypes: true });
  } catch {
    return [];
  }
  const cuentas = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const appDir = join(userdata, d.name, APPID);
    if (!existsSync(appDir)) continue;
    const lst = join(appDir, "remote", "cfg", "dotakeys_personal.lst");
    let tamano = 0;
    let tocado = null;
    try {
      const s = await stat(lst);
      tamano = s.size;
      tocado = s.mtimeMs;
    } catch {}
    cuentas.push({
      id: d.name,
      persona: await personaDe(join(userdata, d.name)),
      appDir,
      layout: await nombreLayout(lst),
      bytes: tamano,
      tocado,
      ultimaPartida: await ultimaPartida(appDir),
    });
  }
  // La cuenta con la configuracion tocada mas recientemente va primero: es la
  // que se esta usando ahora.
  cuentas.sort((a, b) => (b.tocado ?? 0) - (a.tocado ?? 0));
  return cuentas;
}

// Nombre de carpeta seguro a partir de lo que escriba el usuario.
function slug(nombre) {
  const limpio = String(nombre ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9 _-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 48);
  return limpio || null;
}

export async function listarPerfiles() {
  let dirs = [];
  try {
    dirs = await readdir(RAIZ, { withFileTypes: true });
  } catch {
    return [];
  }
  const perfiles = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    let meta = {};
    try {
      meta = JSON.parse(await readFile(join(RAIZ, d.name, "perfil.json"), "utf8"));
    } catch {}
    let bytes = 0;
    try {
      bytes = (await stat(join(RAIZ, d.name, "remote", "cfg", "dotakeys_personal.lst"))).size;
    } catch {}
    perfiles.push({ id: d.name, bytes, ...meta });
  }
  perfiles.sort((a, b) => String(b.guardado ?? "").localeCompare(String(a.guardado ?? "")));
  return perfiles;
}

async function copiarLote(origenBase, destinoBase) {
  const copiados = [];
  for (const rel of ARCHIVOS) {
    const origen = join(origenBase, ...rel.split("/"));
    if (!existsSync(origen)) continue;
    const destino = join(destinoBase, ...rel.split("/"));
    await mkdir(dirname(destino), { recursive: true });
    await copyFile(origen, destino);
    copiados.push(rel);
  }
  return copiados;
}

export async function guardarPerfil({ cuenta, nombre, automatico = false }) {
  const cuentas = await listarCuentas();
  const origen = cuentas.find((c) => c.id === String(cuenta));
  if (!origen) throw new Error("Esa cuenta de Steam no tiene datos de Dota 2.");

  const base = slug(nombre);
  if (!base) throw new Error("Ponle un nombre al perfil.");

  // Nunca pisa uno existente en silencio: si el nombre esta tomado, numera.
  let id = base;
  let n = 2;
  while (existsSync(join(RAIZ, id))) {
    id = `${base}-${n++}`;
  }

  const destino = join(RAIZ, id);
  await mkdir(destino, { recursive: true });
  const archivos = await copiarLote(origen.appDir, destino);

  const meta = {
    nombre: String(nombre).trim(),
    guardado: new Date().toISOString(),
    cuenta: origen.id,
    persona: origen.persona,
    layout: origen.layout,
    ultimaPartida: origen.ultimaPartida,
    automatico,
    archivos,
  };
  await writeFile(join(destino, "perfil.json"), JSON.stringify(meta, null, 2), "utf8");
  return { id, ...meta, bytes: origen.bytes };
}

// Procesos que pelean por estos archivos. Dota los tiene abiertos y los
// reescribe al salir; Steam Cloud puede volver a bajar la version del servidor.
async function procesosAbiertos() {
  try {
    const { stdout } = await ejecutar("tasklist", ["/fo", "csv", "/nh"]);
    const bajo = stdout.toLowerCase();
    return {
      dota: bajo.includes('"dota2.exe"'),
      steam: bajo.includes('"steam.exe"'),
    };
  } catch {
    return { dota: false, steam: false };
  }
}

export async function estado() {
  const [cuentas, perfiles, procesos] = await Promise.all([
    listarCuentas(),
    listarPerfiles(),
    procesosAbiertos(),
  ]);
  return { cuentas, perfiles, procesos, raiz: RAIZ };
}

export async function aplicarPerfil({ perfil, cuenta }) {
  const origen = join(RAIZ, String(perfil));
  if (!existsSync(join(origen, "perfil.json"))) throw new Error("Ese perfil ya no existe.");

  const cuentas = await listarCuentas();
  const destino = cuentas.find((c) => c.id === String(cuenta));
  if (!destino) throw new Error("Esa cuenta de Steam no tiene datos de Dota 2.");

  const procesos = await procesosAbiertos();
  if (procesos.dota) {
    // Con el juego abierto no sirve de nada: Dota tiene los controles en
    // memoria y los vuelve a escribir al cerrar, borrando lo que se copie.
    throw new Error("Cierra Dota 2 antes de aplicar un perfil: al salir reescribe los controles.");
  }

  // Red de seguridad: lo que habia se guarda solo antes de pisarlo.
  let respaldo = null;
  try {
    respaldo = await guardarPerfil({
      cuenta: destino.id,
      nombre: `Antes de ${perfil}`,
      automatico: true,
    });
  } catch {}

  const archivos = await copiarLote(origen, destino.appDir);
  return { archivos: archivos.length, respaldo: respaldo?.id ?? null, steamAbierto: procesos.steam };
}

export async function borrarPerfil({ perfil }) {
  const dir = join(RAIZ, String(perfil));
  if (!existsSync(join(dir, "perfil.json"))) throw new Error("Ese perfil ya no existe.");
  await rm(dir, { recursive: true, force: true });
  return { ok: true };
}

// Lectura y parseo del lockfile del Riot Client.
// Formato: name:pid:port:password:protocol
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const LOCKFILE_PATH = join(
  process.env.LOCALAPPDATA,
  "Riot Games",
  "Riot Client",
  "Config",
  "lockfile"
);

function parse(raw) {
  const [name, pid, port, password, protocol] = raw.trim().split(":");
  if (!port || !password) {
    throw new Error("Lockfile con formato inesperado: " + raw);
  }
  return { name, pid: Number(pid), port: Number(port), password, protocol };
}

export async function readLockfile() {
  let raw;
  try {
    raw = await readFile(LOCKFILE_PATH, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new Error(
        "No existe el lockfile. El cliente de Riot no esta corriendo."
      );
    }
    throw err;
  }
  return parse(raw);
}

// El cliente de League escribe SU PROPIO lockfile en la carpeta de
// instalacion, y es la unica fuente fiable de su puerto: desde 2026 el
// external-sessions del Riot Client ya no publica --app-port ni
// --remoting-auth-token para league_of_legends (solo el puerto del propio
// Riot Client), asi que descubrir el LCU por ahi devuelve nada.
// La ruta de instalacion la declara el metadato del producto; si no esta, se
// prueban las de siempre.
const META_LOL = join(
  process.env.ALLUSERSPROFILE ?? "C:\\ProgramData",
  "Riot Games",
  "Metadata",
  "league_of_legends.live",
  "league_of_legends.live.product_settings.yaml"
);

async function carpetasDeLeague() {
  const rutas = [];
  try {
    const yaml = await readFile(META_LOL, "utf8");
    const m = yaml.match(/product_install_full_path:\s*"?([^"\r\n]+)"?/);
    if (m) rutas.push(m[1].trim());
  } catch {
    // sin metadato: seguimos con las rutas habituales
  }
  rutas.push(
    "C:\\Riot Games\\League of Legends",
    join(process.env.ProgramFiles ?? "C:\\Program Files", "Riot Games", "League of Legends"),
    join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Riot Games", "League of Legends")
  );
  return rutas;
}

export async function readLeagueLockfile() {
  for (const carpeta of await carpetasDeLeague()) {
    try {
      return parse(await readFile(join(carpeta, "lockfile"), "utf8"));
    } catch {
      // esa carpeta no es o el cliente no esta abierto: probamos la siguiente
    }
  }
  return null;
}

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
  const [name, pid, port, password, protocol] = raw.trim().split(":");
  if (!port || !password) {
    throw new Error("Lockfile con formato inesperado: " + raw);
  }
  return { name, pid: Number(pid), port: Number(port), password, protocol };
}

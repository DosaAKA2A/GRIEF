// GRIEF como app de escritorio: arranca el tracker + servidor local y lo
// muestra en una ventana propia. Una sola instancia; segunda invocacion
// enfoca la existente.
import { app, BrowserWindow, dialog, ipcMain, screen, shell } from "electron";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../src/serve.js";

const PORT = 43270; // puerto propio de la app, no choca con npm run ui (4327)

// Proporcion fija del LIENZO (el contenido web, sin marco de Windows): la UI
// escala con el ancho (html { font-size } en vw), asi que la altura justa del
// contenido es siempre ancho / RATIO. La ventana se recorta a eso: ni espacio
// muerto abajo ni recortes, y solo escala en diagonal.
const RATIO = 1134 / 666;
const MARCO = { w: 16, h: 39 }; // marco aproximado de la ventana en Windows

// Encuadre perfecto dentro de un monitor: margenes uniformes proporcionales
// al monitor (como una lamina montada). En vertical la ventana toma el ancho
// util y se ancla arriba con el mismo margen por los tres lados; en
// horizontal se centra sin comerse la pantalla ni quedar enana.
// Devuelve posicion + tamano de CONTENIDO (aplicar con setContentSize).
function encuadre(display) {
  const wa = display.workArea;
  const vertical = wa.height > wa.width;
  let cw, ch, x, y;
  if (vertical) {
    const margen = Math.round(wa.width * 0.07);
    cw = wa.width - margen * 2 - MARCO.w;
    ch = Math.round(cw / RATIO);
    x = wa.x + margen;
    y = wa.y + margen;
  } else {
    ch = Math.round(Math.min(Math.max(wa.height * 0.7, 560), 940));
    cw = Math.round(ch * RATIO);
    const margenMin = Math.round(wa.width * 0.05);
    if (cw > wa.width - margenMin * 2 - MARCO.w) {
      cw = wa.width - margenMin * 2 - MARCO.w;
      ch = Math.round(cw / RATIO);
    }
    x = wa.x + Math.round((wa.width - cw - MARCO.w) / 2);
    // Ligeramente por encima del centro optico, como se cuelga un cuadro
    y = wa.y + Math.round((wa.height - ch - MARCO.h) * 0.42);
  }
  return { x, y, width: cw, height: ch };
}

// Monitor de arranque: el secundario si existe (la app acompana al juego sin
// taparlo); si no, el principal. Solo cuentan secundarios con tamano util:
// paneles auxiliares estrechos (relojes, widgets) no sirven para la app.
function monitorInicial() {
  const primario = screen.getPrimaryDisplay();
  const candidatos = screen
    .getAllDisplays()
    .filter((d) => d.id !== primario.id && d.workArea.width >= 900)
    .sort((a, b) => b.workArea.width * b.workArea.height - a.workArea.width * a.workArea.height);
  return candidatos[0] ?? primario;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    let url;
    try {
      ({ url } = await startServer({ port: PORT }));
    } catch (err) {
      dialog.showErrorBox("GRIEF", `No se pudo arrancar el tracker: ${err.message}`);
      app.quit();
      return;
    }
    const marco = encuadre(monitorInicial());
    const win = new BrowserWindow({
      ...marco,
      useContentSize: true,
      minWidth: 780,
      minHeight: Math.round((780 - MARCO.w) / RATIO) + MARCO.h,
      backgroundColor: "#0f1923",
      title: "GRIEF",
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: join(dirname(fileURLToPath(import.meta.url)), "preload.cjs"),
      },
    });
    win.removeMenu();
    win.setAspectRatio(RATIO); // las esquinas escalan; la forma no cambia
    // Los bordes laterales no redimensionan: solo esquinas (diagonal)
    win.on("will-resize", (e, _bounds, details) => {
      const edge = details?.edge ?? "";
      if (edge && !edge.includes("-")) e.preventDefault();
    });
    win.loadURL(url);
    // Cualquier enlace externo va al navegador del sistema, no a la ventana
    win.webContents.setWindowOpenHandler(({ url: ext }) => {
      shell.openExternal(ext);
      return { action: "deny" };
    });

    // Encuadre bajo demanda desde el menu de la UI: re-monta la ventana en
    // el monitor donde este ahora mismo.
    ipcMain.handle("grief:encuadrar", () => {
      const display = screen.getDisplayMatching(win.getBounds());
      const m = encuadre(display);
      win.setContentSize(m.width, m.height);
      win.setPosition(m.x, m.y, true);
    });
  });

  app.on("window-all-closed", () => app.quit());
}

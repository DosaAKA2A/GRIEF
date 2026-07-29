// GRIEF como app de escritorio: arranca el tracker + servidor local y lo
// muestra en una ventana propia. Una sola instancia; segunda invocacion
// enfoca la existente.
import { app, BrowserWindow, dialog, shell } from "electron";
import { startServer } from "../src/serve.js";

const PORT = 43270; // puerto propio de la app, no choca con npm run ui (4327)

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
    const win = new BrowserWindow({
      width: 1150,
      height: 820,
      minWidth: 760,
      minHeight: 480,
      backgroundColor: "#0f1923",
      title: "GRIEF",
      autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    win.removeMenu();
    win.loadURL(url);
    // Cualquier enlace externo va al navegador del sistema, no a la ventana
    win.webContents.setWindowOpenHandler(({ url: ext }) => {
      shell.openExternal(ext);
      return { action: "deny" };
    });
  });

  app.on("window-all-closed", () => app.quit());
}

// Puente minimo entre la UI (servida por http local) y la ventana Electron.
// Solo existe dentro de la app de escritorio; en el navegador window.grief
// no esta y la UI oculta lo que dependa de el.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("grief", {
  encuadrar: () => ipcRenderer.invoke("grief:encuadrar"),
  actualizar: () => ipcRenderer.invoke("grief:actualizar"),
  onProgreso: (cb) => ipcRenderer.on("grief:progreso", (_ev, pct) => cb(pct)),
});

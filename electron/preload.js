import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("syncdrop", {
  platform: "windows",
  openDownloads: () => ipcRenderer.invoke("syncdrop:open-downloads")
});

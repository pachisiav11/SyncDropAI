import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("syncdrop", {
  platform: "windows",
  openDownloads: () => ipcRenderer.invoke("syncdrop:open-downloads"),
  saveUrl: ({ url, filename }) => ipcRenderer.invoke("syncdrop:save-url", { url, filename })
});

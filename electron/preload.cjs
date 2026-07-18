const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("syncdrop", {
  platform: "windows",
  isElectron: true,
  // Where Supabase should redirect after verifying the email magic link.
  // The main process runs a loopback server on this origin to capture the tokens.
  authRedirectUrl: "http://localhost:3000",
  openDownloads: () => ipcRenderer.invoke("syncdrop:open-downloads"),
  saveUrl: ({ url, filename }) => ipcRenderer.invoke("syncdrop:save-url", { url, filename }),
  // Mirror the current Supabase session to ~/.syncdrop/session.json so the
  // syncdrop CLI can reuse it. Pass null/empty to clear it on sign-out.
  persistSession: (session) => ipcRenderer.invoke("syncdrop:persist-session", session),
  clearSession: () => ipcRenderer.invoke("syncdrop:clear-session"),
  // Storage adapter handed to supabase-js in src/supabaseClient.js. Backs its
  // session on disk (~/.syncdrop/auth-store.json) because localStorage does not
  // persist on the file:// origin the packaged app loads from.
  authStorage: {
    getItem: (key) => ipcRenderer.invoke("syncdrop:auth-storage-get", key),
    setItem: (key, value) => ipcRenderer.invoke("syncdrop:auth-storage-set", { key, value }),
    removeItem: (key) => ipcRenderer.invoke("syncdrop:auth-storage-remove", key)
  },
  // Subscribe to auth tokens captured from the email sign-in redirect.
  onAuthTokens: (callback) => {
    const handler = (_event, tokens) => callback(tokens);
    ipcRenderer.on("syncdrop:auth-tokens", handler);
    return () => ipcRenderer.removeListener("syncdrop:auth-tokens", handler);
  },
  // Fires after the background worker renames one or more files, so the UI can
  // refresh to show the new names.
  onFilesRenamed: (callback) => {
    const handler = (_event, summary) => callback(summary);
    ipcRenderer.on("syncdrop:files-renamed", handler);
    return () => ipcRenderer.removeListener("syncdrop:files-renamed", handler);
  }
});

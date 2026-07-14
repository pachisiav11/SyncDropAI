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
  // Subscribe to auth tokens captured from the email sign-in redirect.
  onAuthTokens: (callback) => {
    const handler = (_event, tokens) => callback(tokens);
    ipcRenderer.on("syncdrop:auth-tokens", handler);
    return () => ipcRenderer.removeListener("syncdrop:auth-tokens", handler);
  }
});

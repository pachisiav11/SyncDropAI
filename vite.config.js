import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("./app", import.meta.url));

export default defineConfig({
  root,
  // Relative asset URLs, so the same build works served from a path, from the
  // Tauri custom protocol, and from a file:// preview.
  base: "./",
  server: {
    port: 5173,
    strictPort: true,
    host: true,
    // The app imports the protocol from outside the Vite root.
    fs: { allow: [fileURLToPath(new URL(".", import.meta.url))] }
  },
  build: {
    outDir: fileURLToPath(new URL("./dist-app", import.meta.url)),
    emptyOutDir: true,
    target: "es2022"
  }
});

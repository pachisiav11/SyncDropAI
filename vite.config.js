import { defineConfig, loadEnv } from "vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("./app", import.meta.url));
const here = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig(({ mode }) => {
  // An installed app cannot work out where the relay is from its own origin:
  // Tauri serves the window from a custom protocol and Capacitor serves it from
  // https://localhost. The address is therefore compiled in. Set SYNCDROP_SERVER
  // once in .env and every build made afterwards ships knowing where to connect,
  // so nobody has to type an address into a phone.
  const env = loadEnv(mode, here, "SYNCDROP_");

  return {
    root,
    // Relative asset URLs, so the same build works served from a path, from the
    // Tauri custom protocol, and from a file:// preview.
    base: "./",
    define: {
      __SYNCDROP_SERVER__: JSON.stringify((env.SYNCDROP_SERVER ?? "").trim())
    },
    server: {
      port: 5173,
      strictPort: true,
      host: true,
      // The app imports the protocol from outside the Vite root.
      fs: { allow: [here] }
    },
    build: {
      outDir: fileURLToPath(new URL("./dist-app", import.meta.url)),
      emptyOutDir: true,
      target: "es2022"
    }
  };
});

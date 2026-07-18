import { createClient } from "@supabase/supabase-js";

export const supabaseUrl = import.meta.env.VITE_SUPABASE_URL ?? "";
export const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY ?? "";

export const storageBucket = import.meta.env.VITE_SUPABASE_BUCKET || "files";
export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

// In the packaged Electron app the renderer loads over file://, and Chromium
// gives that origin a localStorage that reads/writes in memory but is never
// flushed to disk — so supabase-js's default storage lost the session on every
// quit and the app always started signed out. When the preload bridge is
// present we persist through it to ~/.syncdrop/auth-store.json instead. On web
// and Android there is no bridge and localStorage works, so we leave the
// library's default alone. The adapter is async, which supabase-js supports.
const authStorage = globalThis.window?.syncdrop?.authStorage ?? null;

export const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        ...(authStorage ? { storage: authStorage } : {})
      }
    })
  : null;

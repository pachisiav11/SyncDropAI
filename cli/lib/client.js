// Builds an authenticated Supabase client for the CLI by reusing the session
// the desktop app wrote to ~/.syncdrop/session.json. The CLI never logs in on
// its own — if there is no session, it tells the user to sign in via the app.

import { createClient } from "@supabase/supabase-js";
import { readSession, sessionFilePath, writeSession } from "../../src/core/session-store.js";

export class CliError extends Error {}

export async function getClient() {
  const stored = readSession();

  if (!stored) {
    throw new CliError(
      `Not signed in. Open the SyncDrop AI desktop app and sign in first — the CLI reuses that session.\n` +
        `(Looked for ${sessionFilePath()})`
    );
  }

  const { supabaseUrl, supabaseAnonKey, access_token, refresh_token } = stored;
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new CliError(
      "Stored session is missing the Supabase URL or anon key. Re-open the desktop app to refresh it."
    );
  }
  if (!access_token || !refresh_token) {
    throw new CliError("Stored session has no tokens. Sign in again in the desktop app.");
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  });

  const { data, error } = await supabase.auth.setSession({ access_token, refresh_token });
  if (error) {
    throw new CliError(
      `Could not restore your session (${error.message}). Sign in again in the desktop app.`
    );
  }

  const session = data.session;
  if (!session?.user) {
    throw new CliError("Session could not be restored. Sign in again in the desktop app.");
  }

  // setSession may have refreshed the access token — write it back so the next
  // CLI invocation (and the app) sees the fresh token.
  if (session.access_token !== access_token || session.refresh_token !== refresh_token) {
    writeSession({
      ...stored,
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_at: session.expires_at
    });
  }

  const bucket = stored.storageBucket || "files";
  return { supabase, bucket, userId: session.user.id, user: session.user };
}

# SyncDrop — open items

- 2026-09-07 11:40: Verify the Android share sheet on a real handset (built and manifest-verified, not yet run on a device)
- 2026-09-07 11:40: Verify "Send to > SyncDrop" from a real NSIS install (installer built, hooks not yet exercised)
- 2026-09-07 11:40: Measure LAN throughput between two real machines rather than two tabs on one
- 2026-09-07 11:40: Decide whether to delete the dead v1 tree (src/, electron/, supabase/, cli/lib/{client,files,util,worker}.js, root v1 HTML, @supabase/supabase-js)
- 2026-09-09 23:45: Exercise the in-app model download on a machine with no weights present (the path is written and the server side is proven, but the progress UI has only been driven with the files already there)
- 2026-09-10 22:20: CLI — make `syncdrop` runnable from any directory rather than only through `node cli/index.js` in the checkout
- 2026-09-10 22:20: CLI — it hangs with no output when the relay is unreachable, because it waits on a reconnect loop that never gives up
- 2026-09-10 22:20: CLI — it falls back to http://localhost:8787 instead of the relay the apps are built against, so every command waits on a server that is not running
- 2026-09-10 22:20: CLI — no way to fetch or check the naming model, which the desktop app has had since the weights stopped shipping with the installer

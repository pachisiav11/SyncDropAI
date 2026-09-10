# SyncDrop — open items

- 2026-09-07 11:40: Verify the Android share sheet on a real handset (built and manifest-verified, not yet run on a device)
- 2026-09-07 11:40: Measure LAN throughput between two real machines rather than two tabs on one
- 2026-09-07 11:40: Decide whether to delete the dead v1 tree (src/, electron/, supabase/, cli/lib/{client,files,util,worker}.js, root v1 HTML, @supabase/supabase-js)
- 2026-09-09 23:45: Exercise the in-app model download on a machine with no weights present (the path is written and the server side is proven, but the progress UI has only been driven with the files already there)
- 2026-09-10 23:30: The naming model drops the part of a filename that tells two files apart: tally-1.txt, tally-2.txt and tally-3.txt came back as tally-file-1-is-a-list, tally-file-2-is-a-list and tally-file-is-a-list. Nothing is lost, since a collision is renamed rather than overwritten, but the third name no longer says which file it is
- 2026-09-10 23:30: An interrupted model download starts again from nothing, because the part file is truncated rather than resumed. On 1.7 GB that is a long way to lose

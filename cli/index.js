#!/usr/bin/env node
// syncdrop CLI — file operations against the same Supabase project the SyncDrop
// AI desktop/mobile app uses. Auth is app-only: sign in via the desktop app,
// then this CLI reuses that session (see cli/lib/client.js). One-shot commands
// only — no sync, watch, or daemon.

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Command } from "commander";

import { CliError, getClient } from "./lib/client.js";
import {
  deleteFile,
  getSignedUrl,
  listFiles,
  renameFile,
  resolveFile,
  uploadFile
} from "./lib/files.js";
import { formatBytes, formatDate, parseSince, renderTable } from "./lib/util.js";

const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const program = new Command();

program
  .name("syncdrop")
  .description("Manage your SyncDrop AI cloud files from the terminal.")
  .version(pkg.version, "-v, --version", "print the CLI version")
  .addHelpText(
    "after",
    [
      "",
      "Auth:",
      "  Sign in through the SyncDrop AI desktop app first — the CLI reuses that",
      "  session (~/.syncdrop/session.json) and never logs in on its own.",
      "",
      "Examples:",
      "  syncdrop upload ./report.pdf",
      "  syncdrop upload ./raw.png --no-rename",
      "  syncdrop list 5",
      "  syncdrop list --since 24h --search invoice",
      "  syncdrop list --json | jq '.[].filename_ai'",
      "  syncdrop download report.pdf --out ~/Downloads",
      "  syncdrop info <id> --json",
      "  syncdrop rename <id> quarterly-report.pdf",
      "  syncdrop delete report.pdf --yes"
    ].join("\n")
  );

// Bare `syncdrop` (no command) prints the full command list.
program.action(() => program.help());

program
  .command("upload")
  .argument("<path>", "path to the file to upload")
  .option("--no-rename", "keep the original filename (skip the AI rename for this upload)")
  .description("upload a file to your SyncDrop cloud storage")
  .action(async (filePath, options) => {
    const { supabase, bucket, userId } = await getClient();
    const result = await uploadFile({
      supabase,
      bucket,
      userId,
      filePath: path.resolve(filePath),
      noRename: options.rename === false
    });
    console.log(`Uploaded ${result.filename_original} → ${result.filename_ai} (${formatBytes(result.size)})`);
    console.log(`id: ${result.id}`);
  });

program
  .command("list")
  .argument("[count]", "max number of files to show")
  .option("--since <window>", "only files newer than a window, e.g. 30m, 5h, 28d")
  .option("--limit <n>", "max number of files to show", (v) => parseInt(v, 10))
  .option("--search <query>", "filter by filename substring")
  .option("--json", "print raw JSON instead of a table")
  .description("list your cloud files")
  .action(async (count, options) => {
    const { supabase } = await getClient();
    const since = options.since ? parseSince(options.since) : null;
    const limit = options.limit ?? (count != null ? parseInt(count, 10) : null);
    if (limit != null && Number.isNaN(limit)) throw new CliError(`Invalid count/limit value.`);

    const files = await listFiles({ supabase, since, limit, search: options.search });

    if (options.json) {
      console.log(JSON.stringify(files, null, 2));
      return;
    }

    const rows = files.map((f) => ({
      name: f.filename_ai,
      size: formatBytes(f.size),
      from: f.uploaded_from,
      uploaded: formatDate(f.created_at),
      id: f.id
    }));
    console.log(
      renderTable(rows, [
        ["name", "NAME"],
        ["size", "SIZE"],
        ["from", "FROM"],
        ["uploaded", "UPLOADED"],
        ["id", "ID"]
      ])
    );
  });

program
  .command("download")
  .argument("<name|id>", "file name or id to download")
  .option("--out <path>", "destination file or directory (default: current directory)")
  .description("download a file to your machine")
  .action(async (identifier, options) => {
    const { supabase, bucket } = await getClient();
    const file = await resolveFile({ supabase, identifier });
    const url = await getSignedUrl({ supabase, bucket, file });

    let destination = options.out ? path.resolve(options.out) : path.resolve(file.filename_ai);
    if (fs.existsSync(destination) && fs.statSync(destination).isDirectory()) {
      destination = path.join(destination, file.filename_ai);
    }

    const response = await fetch(url);
    if (!response.ok) throw new CliError(`Download failed with status ${response.status}.`);
    const buffer = Buffer.from(await response.arrayBuffer());
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, buffer);

    console.log(`Downloaded ${file.filename_ai} → ${destination} (${formatBytes(buffer.length)})`);
  });

program
  .command("delete")
  .argument("<name|id>", "file name or id to delete")
  .option("-y, --yes", "skip the confirmation prompt")
  .description("delete a file from storage and metadata")
  .action(async (identifier, options) => {
    const { supabase, bucket } = await getClient();
    const file = await resolveFile({ supabase, identifier });

    if (!options.yes) {
      const rl = readline.createInterface({ input: stdin, output: stdout });
      const answer = await rl.question(`Delete "${file.filename_ai}" (${file.id})? [y/N] `);
      rl.close();
      if (!/^y(es)?$/i.test(answer.trim())) {
        console.log("Cancelled.");
        return;
      }
    }

    await deleteFile({ supabase, bucket, file });
    console.log(`Deleted ${file.filename_ai}.`);
  });

program
  .command("rename")
  .argument("<name|id>", "file name or id to rename")
  .argument("<new-name>", "the new display filename")
  .description("rename a file's AI filename (no AI re-naming)")
  .action(async (identifier, newName) => {
    const { supabase } = await getClient();
    const file = await resolveFile({ supabase, identifier });
    const updated = await renameFile({ supabase, file, newName });
    console.log(`Renamed ${file.filename_ai} → ${updated.filename_ai}`);
  });

program
  .command("info")
  .argument("<name|id>", "file name or id")
  .option("--json", "print raw JSON")
  .description("show metadata for a single file")
  .action(async (identifier, options) => {
    const { supabase } = await getClient();
    const file = await resolveFile({ supabase, identifier });

    if (options.json) {
      console.log(JSON.stringify(file, null, 2));
      return;
    }

    const lines = [
      ["Name", file.filename_ai],
      ["Original", file.filename_original],
      ["Size", `${formatBytes(file.size)} (${file.size} bytes)`],
      ["Type", file.mime_type ?? "—"],
      ["Uploaded from", file.uploaded_from],
      ["Uploaded at", formatDate(file.created_at)],
      ["Storage path", file.storage_path],
      ["ID", file.id]
    ];
    const width = Math.max(...lines.map(([label]) => label.length));
    console.log(lines.map(([label, value]) => `${label.padEnd(width)}  ${value}`).join("\n"));
  });

program.parseAsync(process.argv).catch((error) => {
  const message = error instanceof CliError ? error.message : error?.message ?? String(error);
  console.error(`\nError: ${message}`);
  process.exitCode = 1;
});

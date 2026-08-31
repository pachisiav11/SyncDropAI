#!/usr/bin/env node
// SyncDrop CLI.
//
// This is a device in its own right, with its own keypair, paired like any
// other. It does not borrow the desktop app credentials, and there is nothing
// here that can expire.
//
// Node has no WebRTC, so the CLI always travels by the encrypted relay. Files
// are sealed to the recipient key before they leave this machine either way.

import path from "node:path";
import process from "node:process";
import { Command } from "commander";

import { createSyncDrop } from "../protocol/client.js";
import { openVault } from "../protocol/vault.js";
import { formatDeviceId } from "../protocol/identity.js";
import { formatBytes } from "../protocol/util.js";
import { directorySink, fileSource } from "./lib/nodeio.js";
import { fileStorage, readConfig, serverUrl, writeConfig } from "./lib/storage.js";

const VERSION = "2.0.0";

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

function defaultName() {
  const machine = process.env.COMPUTERNAME || process.env.HOSTNAME || "Terminal";
  return readConfig().name || machine + " (CLI)";
}

async function connectClient({ quiet = true, downloadDir } = {}) {
  const vault = await openVault(fileStorage(), { name: defaultName(), platform: "cli" });

  const client = createSyncDrop({
    vault,
    serverUrl: serverUrl(),
    createSink: directorySink(downloadDir ?? readConfig().downloads ?? process.cwd()),
    onEvent: (event) => {
      if (quiet) return;
      if (event.type === "collected") console.log("  received " + event.name + " -> " + event.path);
      if (event.type === "discarded") console.log("  discarded an envelope: " + event.reason);
      if (event.type === "failed") console.log("  failed: " + event.error);
    }
  });

  await client.start();
  return { client, vault };
}

// Accepts a device fingerprint, or any unambiguous part of a device name.
function resolveDevice(client, needle) {
  const peers = client.peers();
  const term = String(needle ?? "").trim().toUpperCase();
  const byId = peers.find((peer) => peer.deviceId === term.replace(/-/g, ""));
  if (byId) return byId;

  const matches = peers.filter((peer) => peer.name.toUpperCase().includes(term));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(needle + " matches " + matches.length + " devices. Use the fingerprint instead.");
  }
  throw new Error("No paired device matches " + needle + ". Run: syncdrop devices");
}

// Naming runs here rather than in the protocol, because it needs Node-only
// decoders and a model running on this machine.
async function suggestName(source) {
  try {
    const { suggestNameFromContent } = await import("./lib/namer.js");
    const head = Buffer.from(await source.readChunk(0, Math.min(source.size, 8 * 1024 * 1024)));
    return await suggestNameFromContent({
      buffer: head,
      mimeType: source.mime,
      originalFilename: source.name
    });
  } catch {
    // No model running, or a format it cannot read: keep the original name.
    return null;
  }
}

const program = new Command();
program
  .name("syncdrop")
  .description("Send files straight between your own devices. No account.")
  .version(VERSION);

program
  .command("id")
  .description("Show this device name and fingerprint")
  .action(async () => {
    const { client } = await connectClient();
    console.log(client.identity.name);
    console.log("  fingerprint  " + formatDeviceId(client.identity.deviceId));
    console.log("  server       " + serverUrl());
    console.log("  paired with  " + client.peers().length + " device(s)");
    client.stop();
  });

program
  .command("pair [code]")
  .description("Pair with another device. With no code, shows one to type there.")
  .action(async (code) => {
    const { client } = await connectClient();
    try {
      const offer = code ? null : client.createPairingOffer();
      if (offer) {
        console.log("\n  Type this on the other device:\n");
        console.log("      " + offer.display + "\n");
        console.log("  Waiting... (expires in five minutes)");
      } else {
        console.log("Pairing...");
      }
      const peer = await client.pair(offer ? offer.code : code);
      console.log("\nPaired with " + peer.name + "  " + formatDeviceId(peer.deviceId));
    } catch (error) {
      fail(error.message);
    } finally {
      client.stop();
    }
  });

program
  .command("devices")
  .description("List paired devices")
  .action(async () => {
    const { client } = await connectClient();
    const peers = client.peers();
    if (peers.length === 0) {
      console.log("No paired devices yet. Run: syncdrop pair");
    } else {
      for (const peer of peers) {
        const dot = client.isOnline(peer.deviceId) ? "online " : "offline";
        console.log("  " + dot + "  " + peer.name.padEnd(24) + " " + formatDeviceId(peer.deviceId));
      }
    }
    client.stop();
  });

program
  .command("send <files...>")
  .description("Send one or more files to a paired device")
  .requiredOption("-t, --to <device>", "device name or fingerprint")
  .option("--rename", "name each file from its content using the local model")
  .action(async (files, options) => {
    const { client } = await connectClient();
    try {
      const peer = resolveDevice(client, options.to);
      for (const filePath of files) {
        const source = await fileSource(filePath);
        try {
          let sending = source;
          if (options.rename) {
            const suggested = await suggestName(source);
            if (suggested) sending = { ...source, name: suggested };
          }
          process.stdout.write("  " + sending.name + " (" + formatBytes(source.size) + ") -> " + peer.name + " ... ");
          const result = await client.send(peer.deviceId, sending);
          console.log(result.via === "relay" ? "queued (relay)" : "sent (" + result.via + ")");
        } finally {
          await source.close();
        }
      }
    } catch (error) {
      fail(error.message);
    } finally {
      client.stop();
    }
  });

program
  .command("receive")
  .description("Collect anything waiting for this device")
  .option("-o, --out <dir>", "where to write files (default: current directory)")
  .option("-w, --watch", "stay running and collect as things arrive")
  .action(async (options) => {
    const downloadDir = path.resolve(options.out ?? process.cwd());
    const { client } = await connectClient({ quiet: false, downloadDir });
    const collected = await client.collect();
    console.log("Collected " + collected.length + " file(s) into " + downloadDir);

    if (!options.watch) {
      client.stop();
      return;
    }
    console.log("Watching for more. Ctrl+C to stop.");
    process.on("SIGINT", () => {
      client.stop();
      process.exit(0);
    });
  });

program
  .command("forget <device>")
  .description("Remove a paired device")
  .action(async (device) => {
    const { client } = await connectClient();
    try {
      const peer = resolveDevice(client, device);
      await client.unpair(peer.deviceId);
      console.log("Forgot " + peer.name);
    } catch (error) {
      fail(error.message);
    } finally {
      client.stop();
    }
  });

program
  .command("config [key] [value]")
  .description("Read or set config: server, name, downloads")
  .action(async (key, value) => {
    if (!key) {
      console.log(JSON.stringify({ server: serverUrl(), ...readConfig() }, null, 2));
      return;
    }
    if (!["server", "name", "downloads"].includes(key)) {
      return fail("Unknown setting " + key + ". Try: server, name, downloads");
    }
    if (value === undefined) {
      console.log(readConfig()[key] ?? (key === "server" ? serverUrl() : ""));
      return;
    }
    writeConfig({ [key]: value });
    if (key === "name") {
      const vault = await openVault(fileStorage(), { name: value, platform: "cli" });
      await vault.rename(value);
    }
    console.log(key + " = " + value);
  });

program
  .command("serve")
  .description("Run a rendezvous and relay server on this machine")
  .option("-p, --port <port>", "port to listen on", "8787")
  .option("-d, --data <dir>", "where to keep queued ciphertext")
  .action(async (options) => {
    const { startServer } = await import("../server/node.js");
    await startServer({
      port: Number(options.port),
      dataDir: options.data ?? path.join(process.cwd(), ".syncdrop-data")
    });
  });

program.parseAsync(process.argv).catch((error) => fail(error.message));

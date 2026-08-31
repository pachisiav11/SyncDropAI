import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes as nodeRandomBytes } from "node:crypto";

import { startServer } from "../server/node.js";
import { createSyncDrop } from "../protocol/client.js";
import { memoryStorage, openVault } from "../protocol/vault.js";
import { directorySink, fileSource, guessMime } from "../cli/lib/nodeio.js";
import { memorySink } from "../protocol/sources.js";

test("cli io: real files move between two devices via the relay", async (t) => {
  const server = await startServer({ port: 0, host: "127.0.0.1", verbose: false });
  const serverUrl = "http://127.0.0.1:" + server.port;
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "syncdrop-cli-"));
  const inbox = path.join(work, "inbox");

  const received = [];
  const laptopVault = await openVault(memoryStorage(), { name: "Laptop", platform: "cli" });
  const deskVault = await openVault(memoryStorage(), { name: "Desk", platform: "windows" });

  const laptop = createSyncDrop({ vault: laptopVault, serverUrl, createSink: memorySink() });
  const desk = createSyncDrop({
    vault: deskVault,
    serverUrl,
    createSink: directorySink(inbox),
    onEvent: (event) => event.type === "collected" && received.push(event)
  });

  await laptop.start();
  await desk.start();

  t.after(async () => {
    laptop.stop();
    desk.stop();
    await server.close();
    await fs.rm(work, { recursive: true, force: true });
  });

  await t.test("mime guessing covers the common cases", () => {
    assert.equal(guessMime("a/b/photo.JPG"), "image/jpeg");
    assert.equal(guessMime("notes.md"), "text/markdown");
    assert.equal(guessMime("archive.unknownext"), "application/octet-stream");
  });

  await t.test("a file source reads a real file in slices", async () => {
    const filePath = path.join(work, "slices.bin");
    const bytes = nodeRandomBytes(10000);
    await fs.writeFile(filePath, bytes);

    const source = await fileSource(filePath);
    assert.equal(source.size, 10000);
    assert.equal(source.name, "slices.bin");

    const first = await source.readChunk(0, 4096);
    const last = await source.readChunk(8192, 4096);
    assert.equal(first.length, 4096);
    assert.equal(last.length, 10000 - 8192, "a short final chunk is not padded");
    assert.ok(Buffer.from(first).equals(bytes.subarray(0, 4096)));
    await source.close();
  });

  await t.test("paired devices move a real file onto disk", async () => {
    const offer = laptop.createPairingOffer();
    await Promise.all([laptop.pair(offer.code), desk.pair(offer.code)]);

    const filePath = path.join(work, "quarterly-report.pdf");
    const bytes = nodeRandomBytes(300000);
    await fs.writeFile(filePath, bytes);

    const source = await fileSource(filePath);
    const result = await laptop.send(desk.identity.deviceId, source);
    await source.close();
    assert.equal(result.via, "relay", "Node has no WebRTC, so the relay carries it");

    const deadline = Date.now() + 5000;
    while (received.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(received.length, 1);

    const landed = path.join(inbox, "quarterly-report.pdf");
    const written = await fs.readFile(landed);
    assert.ok(written.equals(bytes), "the file on disk is byte-identical");
    assert.deepEqual(await fs.readdir(inbox), ["quarterly-report.pdf"], "no .part file is left behind");
  });

  await t.test("a second file with the same name does not overwrite the first", async () => {
    const filePath = path.join(work, "dupe.txt");
    await fs.writeFile(filePath, "first");
    let source = await fileSource(filePath, { name: "quarterly-report.pdf" });
    await laptop.send(desk.identity.deviceId, source);
    await source.close();

    const deadline = Date.now() + 5000;
    while (received.length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }

    const listing = (await fs.readdir(inbox)).sort();
    assert.deepEqual(listing, ["quarterly-report (1).pdf", "quarterly-report.pdf"]);
    assert.equal(await fs.readFile(path.join(inbox, "quarterly-report (1).pdf"), "utf8"), "first");
  });

  await t.test("a path that is not a file is refused", async () => {
    await assert.rejects(() => fileSource(work), /not a file/);
  });
});

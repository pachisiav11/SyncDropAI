# SyncDrop

Send a file from your phone to your PC, or from your PC to your phone, by
picking the device and pressing send. No account, no sign-in, no upload to
somebody else's drive and back down again.

When both devices are awake the file goes **straight between them** — on the
same Wi-Fi it never leaves the building. When the other device is asleep the
file is encrypted on the sender and parked on a relay, and the relay hands it
over the next time that device wakes up. The relay cannot read it. It cannot
even tell you what the file is called.

---

## Why it works this way

The first version of SyncDrop had accounts. Every device signed in, held a
token, and refreshed it in the background. That model has a failure mode you
cannot engineer away: a token expires, or two processes rotate the same refresh
token and one of them loses the race, and the device is signed out. The user did
nothing wrong and there is nothing to fix except signing in again.

So the account is gone. A device's identity is a **keypair it generates on first
run and never sends anywhere**. To prove who it is, it signs a challenge. That
signature cannot expire, cannot be revoked by a server, and cannot go stale
while the laptop is closed. There is no session to lose, because there is no
session.

Two devices become "paired" when a six-word code is read off one screen and
typed into the other. From then on they know each other's public keys, and
everything between them is encrypted to those keys.

---

## Pairing

One device shows a code:

```
brave-otter-marble-forest-quiet-anchor
```

The other device types it. Both sides run the code through a slow key
derivation and land in the same rendezvous room on the server. Inside that room
they exchange public keys and each proves it knew the code, by sending an HMAC
over a transcript of both keys.

The server relays those two messages and learns nothing useful from them. It
never sees the code, and it cannot substitute its own key for either side —
the confirmation tag would not match, and both devices would refuse. The room
closes ten minutes after it opens.

After pairing, the code is worthless. It is not a password and it is never
used again.

---

## How a file gets across

SyncDrop tries three routes, in this order, and tells you which one it used.

**1. Direct, on your network.** Both devices are on the same Wi-Fi, so WebRTC
finds the local address and opens a data channel between them. Nothing leaves
the LAN. This is the fast path, and on a home network it is roughly as fast as
the network is.

**2. Direct, over the internet.** Different networks, both awake. WebRTC punches
through the routers and the file still goes device to device — the server only
introduced them.

**3. The encrypted relay.** The other device is asleep, or the network refuses
to cooperate. The sender derives a fresh key for this one transfer, encrypts the
file in parts, and uploads the ciphertext. The recipient picks it up whenever it
next comes online, decrypts it, and the relay deletes its copy.

Route 3 is why **only the sender needs to be awake**. You can send a file to
your desktop from the train, close your phone, and the file is on the desktop
when you get home.

---

## How fast, and against what

Three claims here are worth separating.

**The file that arrives is the file that was sent.** WhatsApp re-encodes photos
and video on the way through; a 12 MP picture comes out the other side as
something considerably smaller and softer. SyncDrop moves the original bytes and
the tests check that byte for byte, so a RAW file, a video, or a signed PDF
arrives as itself. There is also no 2 GB ceiling: transfers stream, so size is
limited by the receiving disk rather than by the protocol.

**On the same Wi-Fi the file does not leave the building.** It goes straight
from one device to the other. Nothing is uploaded and then downloaded again,
which is the shape that makes a phone-to-laptop transfer slow no matter how
fast the link is.

**The software is not the bottleneck.** Three things in this pipeline were, and
each was measured on its own and fixed:

| | before | after |
|---|---|---|
| reading the file to send | 57 MB/s | 475 MB/s |
| writing the file received | 73 MB/s | 388 MB/s |
| redrawing the progress bar | once per 64 KiB chunk | once per frame |

The last one mattered most and was the least obvious: the app rebuilt its
panels on every chunk, which blocked the same event loop the data channel runs
on, so drawing the progress bar was slowing down the transfer it was drawing.
Of the time a 32 MB transfer now takes, reading the file accounts for about 0.9
seconds and hashing it for 0.09 — the rest is the transport.

What is deliberately **not** claimed here is a megabits-per-second figure for a
real LAN transfer. Measuring that honestly needs two machines; running both
ends in one browser on one laptop measures the laptop, not the network.

---

## Sharing into SyncDrop

You should not have to open the app to send something. Both platforms register
where the operating system expects a share target to be.

**Android.** SyncDrop appears in the share sheet next to WhatsApp, for any file
type, one file or several. Share → SyncDrop → pick a device. If SyncDrop is
already open, the share lands in the window that is already running rather than
starting a second one. The file is not copied first: the app reads the shared
handle on demand, so choosing a 2 GB video costs nothing until you press send.

**Windows.** Right-click → Send to → SyncDrop, or right-click → Send with
SyncDrop. Both are registered by the installer, per user, and both are removed
again when you uninstall. Windows has no share sheet an ordinary desktop app can
join — the Share contract is open only to MSIX-packaged apps — so these two
menus are where the feature actually lives. On Windows 11 the right-click entry
sits under "Show more options", which is where every unpackaged app lands.

Either route starts SyncDrop with the file path, and the running window picks it
up, so sharing never leaves you with two copies of the app open.

---

## Naming files by their content

On the desktop app there is a toggle: **Name files by their content**. With it
on, a file is looked at before it is sent, and a name is suggested from what is
actually in it — `IMG_2841.png` goes out as `handwritten-recipe-card.png`,
`scan_0001.pdf` as `train-ticket-to-bristol.pdf`.

The model runs on your machine, through Ollama. Nothing is uploaded to get a
name, it costs nothing per file, and it works with no network at all. If Ollama
is not running, the send simply keeps the original filename — naming can never
be the reason a transfer fails.

It is deliberately a laptop-only feature. The toggle is disabled in the browser
and on the phone, because running a vision model is not something a phone should
be asked to do on the way to sending a photo.

```bash
ollama pull minicpm-v4.6
```

Images, PDFs, and text-shaped files are read. Archives, video, and formats that
cannot be decoded keep their original name. Override the model with
`SYNCDROP_NAMER_MODEL` if you prefer a different one.

---

## Where bytes can rest

The honest version, because "encrypted" on its own means very little.

**Plaintext exists in exactly two places: the sending device and the receiving
device.** Nowhere else, at any point, under any route.

When both devices are awake the file goes straight between them and no third
machine touches it at all. When the receiver is asleep the sender encrypts the
file and parks the ciphertext on the relay. The relay is the only case where
anything rests off-device, and what rests there is:

- encrypted with a key derived for that one transfer, which the relay never sees
- numbered parts and a recipient id, with the filename and the file type sealed
  *inside* the envelope rather than beside it
- deleted the moment the recipient confirms it has the file, and in any case
  after seven days

The relay can see which device ids talk to each other, how many bytes moved, and
when. That is unavoidable for anything that routes traffic. It cannot see the
file, the filename, the file type, or any key. There is a test that asserts
exactly this: the storage the operator can read is searched for the filename and
for the file's own bytes, and neither is there.

Content keys come from an ephemeral key agreement per transfer, so a device key
that leaks tomorrow does not decrypt the files you sent today.

Two smaller things, for completeness. A STUN server is asked one question —
"what does my address look like from out there?" — and carries no data, but it
does learn your IP, so the default is one operator rather than a list. And there
is deliberately **no TURN server**: TURN would mean a third party relaying your
traffic, so when a direct path cannot be built SyncDrop falls back to its own
encrypted relay instead, which is the same trust boundary as everything else.

---

## Running it

```bash
npm install
```

### The one address to set

Everything else here is account-free, but two devices still have to agree on
where they meet. A packaged app cannot work that out for itself: the Windows
shell serves its window from a custom protocol and the Android shell serves it
from `https://localhost`, so neither origin says anything about where the relay
lives. Guessing from the origin is exactly how setup used to fail.

So the address is compiled in. Copy `.env.example` to `.env` and set it once:

```
SYNCDROP_SERVER=https://syncdrop.example.workers.dev
```

Every build made afterwards ships knowing where to connect, so somebody who
installs SyncDrop never types an address: they open it and pair. Leave it empty
and the web build falls back to the origin it was served from, which is right
when the relay is the thing serving it.

If the app cannot reach that address it says so on the first screen, names the
address it tried, and puts the field to change it one button away, instead of
sitting on "Connecting" for ever.

### The web app

```bash
npm run dev
```

It is a PWA, so it installs to a phone home screen from the browser menu and
registers as a share target — "Share → SyncDrop" from any Android app.

### The desktop app (Windows)

```bash
npm run tauri:dev
```

Tauri, so the shell is Rust and the UI is the same web app running in WebView2 —
around 10 MB rather than the 150 MB an Electron build costs. Three things the
browser cannot do live in the Rust side:

- the device's private key is sealed with DPAPI, encrypted to your Windows
  account, instead of sitting in browser storage
- received files stream straight to a folder you choose
- the local vision model that names files by their content runs in-process

Build an installer with `npm run tauri:build`.

### Android

```bash
npm run build
npm run cap:sync
cd android && ./gradlew assembleDebug
```

The APK lands in `android/app/build/outputs/apk/debug/`. Set `.env` before
`npm run build`, or the phone will not know which relay to call.

### The command line

```bash
npm link          # puts `syncdrop` on your PATH
syncdrop pair     # shows a code; type it into the app
syncdrop send report.pdf --to desk
syncdrop receive --watch
```

The CLI is a device like any other — it has its own keypair and appears in the
app's device list. Node has no WebRTC, so a CLI transfer always takes the
encrypted relay.

---

## Running your own server

The server does two things: it introduces devices to each other, and it holds
encrypted parts for a device that is asleep. It has no database, no user table,
and no secrets to configure, because there are no accounts to store.

**On your own machine, a VPS, or a Pi:**

```bash
npm run serve
```

That serves the rendezvous socket, the relay API, and the built app from one
process. It prints the address to use from elsewhere on the network, because a
phone cannot dial `localhost`; put that in `.env` before building the APK. Point
`SYNCDROP_DATA` at a directory to keep queued transfers across restarts.

A relay on a home network is plain HTTP, which both packaged apps have to be
allowed to reach: the Android build ships a network security config that permits
cleartext, and the desktop build's `connect-src` accepts any host. Neither is a
weakening of what SyncDrop promises — the relay is untrusted infrastructure by
design, carrying ciphertext and routing ids only — but both are deliberate, and
worth knowing about.

**On Cloudflare:**

```bash
npx wrangler r2 bucket create syncdrop-blobs
npm run build
npx wrangler deploy
```

One deploy puts the app and the relay on the same origin. The parts live in R2;
the state lives in Durable Objects, one per device, one per pairing room, one
per queued transfer. Nothing is central: two devices that talk to each other
never touch an object that a third device also touches, so adding devices adds
objects rather than load. Each queued transfer sets its own expiry alarm and
deletes its own bytes, so nothing has to sweep anything.

The rules that decide who may read a blob or claim a mailbox entry are the same
file (`server/core.js`) in both hosts. There is only one copy of that logic, so
there is only one copy to get right.

---

## Layout

```
protocol/     the whole protocol: identity, pairing, transfer, transports.
              No DOM and no node: imports, so the browser, Node, and the
              Worker all run the same bytes.
server/       core.js is host-agnostic. node.js self-hosts. worker/ is
              Cloudflare.
app/          the web app and PWA.
src-tauri/    the Windows shell.
cli/          the terminal client.
test/         node --test. Real WebRTC, real workerd, real files on disk.
```

## Tests

```bash
npm test
```

The suite is not made of mocks. Transfers are checked byte for byte, the
Cloudflare host runs on the actual workerd runtime with real Durable Objects
and a real R2 bucket, and the tests that matter most are the adversarial ones:
a forged signature, a stale timestamp, a device reading another device's
mailbox, a corrupted chunk in flight, a server asked to name a file it is
holding.

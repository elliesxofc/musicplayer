# Stagelight

A remote control for OBS in any browser, behind a password. It runs on the stream PC
(in the tray, by the clock) and lets a phone, tablet or another PC go live, end the
stream, record, switch scenes, show or hide sources and mix audio, with the stream's
health (bitrate, dropped frames, fps, CPU) live.

**Preview**: the panel shows what OBS shows (refreshed about once a second; switch "live"
off to save mobile data). Turn on **edit layout** to see every source's box: tap one to pick it,
drag to move it, drag its corner to resize (it keeps its shape). Add **text**, a **website**
(browser source: alerts, chat, widgets, picture links) or a **colour box** to the current
scene; edit a text's words, hide or remove a source. Changes show on stream straight away.

Separate from moonlit: its own program, installer and settings.

## Get it

Repo's **Actions** tab → **stagelight app** → the latest run → download
**stagelight-windows**, unzip, run `stagelight-setup-….exe`. (Windows may say
"Windows protected your PC" because the app isn't signed: **More info → Run anyway**.)

## Set it up (on the stream PC)

1. **OBS**: Tools → WebSocket Server Settings → tick **Enable WebSocket Server** →
   **Show Connect Info**. Copy the port and password into Stagelight → **connect to OBS**.
2. **Panel password**: pick a new one (at least 8 characters), only for people you
   trust to run your stream.
3. **Open the panel**: Stagelight shows the address, like `http://192.168.1.20:4850`.
   Open it on a phone or PC on the same Wi-Fi and log in. The first time, Windows asks
   whether Stagelight may use the network: allow **private networks**.

Closing the window keeps Stagelight running in the tray, so the panel keeps working.
"Start Stagelight with Windows" keeps it there after a restart.

## From anywhere: Tailscale

Don't open a port on your router for Stagelight. Use [Tailscale](https://tailscale.com/download)
(free) instead:

1. Install Tailscale on the stream PC and sign in.
2. Install it on the phone or PC that controls the stream. Same account, or share the
   stream PC with a friend's account (Tailscale admin console → the PC → **Share**).
3. Stagelight shows a second address starting with `100.`. Open it on that device,
   from anywhere.

Only your devices (and people you share with) can reach the panel that way.

## Safety

- The OBS WebSocket password stays on the stream PC (encrypted); the panel never gets it.
- The panel password is stored only as a scrypt hash. Logging in lasts 12 hours.
- 5 wrong passwords lock that device out for a minute, doubling each time (up to an hour).
- Changing the password, or **log everyone out**, ends every login.
- The panel can only do the things above: no OBS settings, no files, nothing else.
  Websites it adds must be `http://` or `https://` addresses (no files from the PC).
- Going live, ending the stream and stopping a recording ask first.
- On the same Wi-Fi the panel is plain `http`, so use it on networks you trust (your
  home); through Tailscale it's encrypted.

## Run from the source code

```
npm install                # in the repo's main folder (for Electron)
npx electron stagelight    # opens Stagelight
npx electron-builder --projectDir stagelight --win   # builds the installer (on Windows)
```

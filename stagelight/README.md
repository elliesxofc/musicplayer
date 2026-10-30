# Stagelight

A remote control for OBS in any browser, behind a password. It runs on the stream PC
(in the tray, by the clock) and lets a phone, tablet or another PC go live, end the
stream, record, switch scenes, show, hide or refresh sources (one browser source, or all of them at once), change a browser
source's web address, size, frame rate and custom CSS, and edit the layout of any scene (also one
that isn't on stream, without viewers seeing it, then switch to it when it's ready),
with the preview on the whole screen; upload pictures, videos and sounds from the phone straight
into a scene (checked by their contents, 200 MB at most, kept in Stagelight's uploads folder); and,
with full access, OBS's own settings: stream server and key (the key is never shown, only
replaced), bitrate (simple output mode), canvas and output size, frame rate, recording folder,
profile and scene collection and mix audio, with the stream's
health (bitrate, dropped frames, fps, CPU) live.

**Preview**: the panel shows what OBS shows (refreshed about once a second; switch "live"
off to save mobile data). Turn on **edit layout** to see every source's box: tap one to pick it,
drag to move it, drag its corner to resize (it keeps its shape). Add **text**, a **website**
(browser source: alerts, chat, widgets, picture links) or a **colour box** to the current
scene; edit a text's words, hide or remove a source. Changes show on stream straight away.

**Remote display (the whole PC)**: like AnyDesk or Parsec, inside the panel, for when you need
OBS's full window. Off unless you switch it on in Stagelight on the stream PC (**4 · remote
display**): "allow seeing this PC's screen", and separately "also allow mouse and keyboard".
Only **full access** accounts see it. In the panel, **open the PC's full screen** asks for that account's password again, then shows the
screen live (smooth 720p, sharp 1080p or fast 60 fps; pick the screen if there are several).
With mouse and keyboard on: a mouse works like a mouse, a real keyboard types when the
screen is clicked; on a phone, pick **direct touch** (tap to click, hold to right-click, drag to
drag, two fingers to scroll) or **trackpad** (slide to move the cursor, tap to click, two-finger
tap or hold to right-click, tap then touch again and slide to drag, two fingers to scroll), and
**keys** opens a text box plus ctrl / alt / shift / win, esc, tab, enter and arrows.
While someone is connected, a bar at the top of the stream PC's screen says who, with a
**stop** button (also in the tray menu and the settings window), and Windows shows a
notification. One person at a time. Mouse and keyboard need Windows; the video goes straight
between the two devices (same network or Tailscale), never through anything else.

Separate from moonlit: its own program, installer and settings.

## Get it

Repo's **Actions** tab → **stagelight app** → the latest run → download
**stagelight-windows**, unzip, run `stagelight-setup-….exe`. (Windows may say
"Windows protected your PC" because the app isn't signed: **More info → Run anyway**.)

## Set it up (on the stream PC)

1. **OBS**: Tools → WebSocket Server Settings → tick **Enable WebSocket Server** →
   **Show Connect Info**. Copy the port and password into Stagelight → **connect to OBS**.
2. **Accounts**: add one for everyone who'll use the panel, each with their own username,
   password (new ones, at least 10 characters) and access:
   - **full access**: everything, and the remote display of the whole PC (when it's on)
   - **stream control**: going live, recording, scenes, sources, audio and the layout
   - **watch only**: sees everything (status, preview), changes nothing

   Changing someone's password or access, or removing them, logs them out right away.
   (Updating from 1.2 or older: the old panel password becomes the account `stagelight`
   with full access. Add your own accounts, then remove it.)
3. **Open the panel**: Stagelight shows the address, like `http://192.168.1.20:4850`.
   Open it on a phone or PC on the same Wi-Fi and log in with a username and password. The first time, Windows asks
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

## From anywhere: your own web address (Cloudflare Tunnel)

Instead of Tailscale, the panel can be at your own address, like `https://stage.lilianax.lol`:

1. Put the domain on Cloudflare (free plan; change the nameservers where the domain was bought).
2. Cloudflare → Zero Trust → Networks → Tunnels → create a **cloudflared** tunnel, install it on
   the stream PC (Command Prompt as administrator), and add a public hostname: `stage` ·
   `lilianax.lol` · type `HTTP` · URL `localhost:4850`.
3. In Stagelight, **your own web address**: type `stage.lilianax.lol` and tick **allow access
   through a web address**. Stagelight shows "working ✓" after the first visit.
4. Recommended: Cloudflare Access (Zero Trust → Access → Applications → self-hosted) with a policy
   that only allows your and your friend's email addresses.

Through the web address: off unless switched on; only that address is accepted; logins only over
HTTPS (Secure cookie, HSTS); each visitor (by Cloudflare's `CF-Connecting-IP`) is locked out on
their own; 30 wrong tries from the internet in 10 minutes pause web logins for 15 minutes (the
home network and Tailscale keep working). The remote display also tries a direct connection
over the internet (STUN), which works on many networks but not all.

## Light on the stream PC

Stagelight is made to stay out of OBS's way:

- every Stagelight process runs at **below normal** priority, so a busy PC serves OBS first
- with no panel open it checks OBS every 15 seconds (every 2 while someone looks); OBS tells
  it about changes straight away either way
- the preview is at most one picture a second, shared by every open panel, smaller while
  you're live, slower whenever OBS takes long to make one, and not sent again when unchanged
- the settings window really closes (no memory used until it's opened again)
- the remote display's video is H.264, which most PCs encode on the graphics card, and the
  screen-sharing part closes a minute after a session ends
- while you're live, the remote display shares the upload with the stream and the stream comes
  first: the picture stays at 1.2 Mbps and 15 fps, and drops to 0.4 Mbps and 8 fps as soon as
  OBS drops frames, struggles to send or reconnects, until the stream has been fine for a minute
- file transfer (like AnyDesk's), a separate switch under the remote display, off by default: full
  access accounts browse the stream PC's drives and folders, download files (a folder as a .zip,
  up to 4 GB), upload files or whole folders into the open folder, and make folders, after typing
  their password again (good for 30 minutes of use). Nothing can be deleted, renamed or
  overwritten (a taken name gets " (2)"); every transfer is logged and shows a notification
- remote display on a phone: pinch to zoom in (up to 5×) like AnyDesk, move both fingers to look
  around, "reset" in the bar to zoom back out (ctrl + wheel on a laptop); two fingers sliding
  together still scroll the PC, and in trackpad mode the view follows the pointer. The bar shows
  the stream PC's name once connected
- the remote display watches the stream PC's processor too: when the picture is made by the
  processor (no graphics card encoder), it's kept at 15 fps and about 720p; when the whole PC is at
  85% or more for a few seconds, it drops to 10 fps and a smaller picture until the PC is under 65%
  again (the log says how busy the PC was and how much of it was Stagelight); the panel's preview
  pauses while the remote display is open; the screen sharing gets low priority as it starts
- the remote display's picture menu has **light · 480p** (about 0.8 Mbps) for a weak connection, and
  Stagelight's settings can cap the upload it may use at any time (4, 2, 1 or 0.5 Mbps)

## Safety

- The OBS WebSocket password stays on the stream PC (encrypted); the panel never gets it.
- Every account has its own password, stored only as a scrypt hash. Logging in lasts 12 hours.
- What an account may do is checked by Stagelight for every single request, not just hidden
  in the panel.
- 5 wrong tries lock that device out for a minute, doubling each time (up to an hour); a wrong
  username and a wrong password look the same.
- Changing an account, removing it, or **log everyone out** ends those logins right away.
- The panel can only do the things above: no OBS settings, no files, nothing else.
  Websites it adds must be `http://` or `https://` addresses (no files from the PC).
- Going live, ending the stream and stopping a recording ask first.
- Remote display: off by default, full access accounts only, mouse and keyboard a second switch, the account's password again before
  it starts, a visible bar with a stop button on the stream PC while it's on, and any key or
  mouse button still held is let go when it ends. With mouse and keyboard on, every full access
  account can use the whole PC: switch it off when you don't need it.
- Windows doesn't let other programs click into programs running "as administrator"; if OBS
  runs that way, run Stagelight as administrator too (or OBS normally) for mouse and keyboard.
- On the same Wi-Fi the panel is plain `http`, so use it on networks you trust (your
  home); through Tailscale it's encrypted.

## Run from the source code

```
npm install                # in the repo's main folder (for Electron)
npx electron stagelight    # opens Stagelight
npx electron-builder --projectDir stagelight --win   # builds the installer (on Windows)
```

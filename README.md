# ☾ moonlit

a little private music player, just for me.

a pink see-through vinyl that spins while your songs play, with a glowing
visualizer ring that dances to the music, floating hearts, and a background
that takes on the colours of the album cover.

## privacy

- songs never leave your device. there are no accounts, no servers and no tracking.
- your library is saved in this browser's own storage (IndexedDB), so it's still
  there next time you open the page. clearing site data removes it.

## live

**https://elliesxofc.github.io/musicplayer/**

## install it as an app

- **iPhone / iPad:** open the link in Safari → Share → **Add to Home Screen**
- **Android:** open the link in Chrome → ⋮ menu → **Install app** (or use the install button in the sliders panel)
- **computer:** Chrome / Edge show an install icon in the address bar

the app opens full screen with its own icon and works offline. each install has
its own library, so add your songs inside the app itself.

## using it

open `index.html` through any static host (GitHub Pages works great), then
drag audio files onto the page or tap **add songs**.

- reads song titles, artists, albums and cover art from mp3 tags. other files
  use their filename (`Artist - Title.mp3`).
- loved songs, search, shuffle, repeat (all / one)
- picks up where you left off
- six pink themes: midnight rose, strawberry milk, cherry noir, bubblegum, sakura dusk, rosé gold
- customize panel (sliders icon): theme, your name for the greeting, optional watermark
- **stream control** (desktop app): go live, record, switch scenes, show/hide sources and mix audio in OBS from moonlit, through OBS's WebSocket server. see [`OBS-SETUP.txt`](OBS-SETUP.txt)
- **OBS overlay** (desktop app): a live now-playing card with cover, a ticking time and music bars that move with the song (switchable), as an OBS Browser source at `http://localhost:4848/overlay`. see [`OBS-SETUP.txt`](OBS-SETUP.txt)
- **Spotify** (desktop app): connect your Spotify account to see what's playing there with play / pause / skip; while Spotify plays, the overlay, `nowplaying.txt` and `!song` show the Spotify song
- **!song** (desktop app): viewers type `!song` in your YouTube live chat and your bot answers with the current song; give it your channel and it finds each live stream by itself
- **sound output picker**: send the music to a virtual cable (VB-CABLE) so OBS streams it without it playing on your speakers. setup in [`OBS-SETUP.txt`](OBS-SETUP.txt)
- **effects** (sliders panel): *full* · *lite* (no blur/glow/visualizer, record still spins) · *super lite* (no animations, record put away) for older or always-on PCs
- skips songs that won't play, so a 24/7 stream never goes silent
- **OBS now playing**: keeps a `nowplaying.txt` updated with the current song for an OBS text source. see [`OBS-SETUP.txt`](OBS-SETUP.txt)
- works with media keys and the lock screen

## desktop app (Windows / Mac / Linux)

the same player as a real program, built with Electron. made for an always-on
stream PC: it never gets put to sleep, writes the OBS song file without asking
for permission every time, and can start with the PC and resume playing by itself
(sliders panel → **desktop app**).

**easiest: download it.** open the repo's **Actions** tab → **desktop app** →
the latest run → download **moonlit-windows** (unzip it):

- `moonlit-setup-….exe` installs it like a normal program

Windows may say "Windows protected your PC" because the app isn't signed:
click **More info → Run anyway**.

**or run it from the source code** (needs [Node.js](https://nodejs.org) LTS):

```
npm install
npm start          # opens moonlit
npm run dist:win   # builds the Windows installer into dist/ (run this on Windows)
```

**make it your default music player (Windows):** install with `moonlit-setup`, then right-click any song → **Open with** →
**Choose another app** → **moonlit** → **Always**. or: Settings → Apps → Default apps →
moonlit, and pick it for .mp3, .m4a, .flac, .wav, .ogg, .opus, .aac. double-clicking a
song then plays it in moonlit (and adds it to your library the first time).

**download songs (desktop app):** the ⬇ button at the top. paste (or drag in) a link:

- YouTube / YouTube Music songs and playlists, SoundCloud and other sites yt-dlp supports
- Spotify songs, albums and playlists (first 100 songs). Spotify's own audio is copy-protected
  and never touched: moonlit reads the song names, finds each one on YouTube and tags the
  file with the Spotify title, artist, album and cover
- m4a (fastest, no re-encoding) or mp3; 3 downloads at once, each in 4 parallel chunks
- saved to Music/moonlit (changeable) and added to your library automatically
- uses [yt-dlp](https://github.com/yt-dlp/yt-dlp), downloaded on first use and kept up to date,
  and a bundled ffmpeg

only download what you're allowed to, and keep in mind streaming copyrighted songs can get a
stream muted or taken down.

the desktop app keeps its own library, separate from the website and the phone app,
so add your songs inside it.

### keyboard

| key | does |
| --- | --- |
| space / k | play · pause |
| ← → | seek 5s |
| ↑ ↓ | volume |
| n / p | next · previous |
| l | love |
| s / r / m | shuffle · repeat · mute |

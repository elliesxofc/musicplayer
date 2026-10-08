# ☾ moonlit

a little private music player, just for me.

a dreamy vinyl turntable that spins while your songs play, with a soft
visualizer ring that dances to the music and a background that takes on
the colours of the album cover.

## privacy

- songs never leave your device. there are no accounts, no servers and no tracking.
- your library is saved in this browser's own storage (IndexedDB), so it's still
  there next time you open the page. clearing site data removes it.

## using it

open `index.html` through any static host (GitHub Pages works great), then
drag audio files onto the page or tap **add songs**.

- reads song titles, artists, albums and cover art from mp3 tags. other files
  use their filename (`Artist - Title.mp3`).
- loved songs, search, shuffle, repeat (all / one)
- picks up where you left off
- six themes: moonlight, peach fuzz, sakura, matcha, night swim, noir
- tap the greeting to tell it your name
- works with media keys and the lock screen

### keyboard

| key | does |
| --- | --- |
| space / k | play · pause |
| ← → | seek 5s |
| ↑ ↓ | volume |
| n / p | next · previous |
| l | love |
| s / r / m | shuffle · repeat · mute |

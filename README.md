<div align="center">
  <img src="images/banner.png" alt="ChungusHub: a self-hosted workspace for long-form roleplay">

<p><br></p>

ChungusHub is a local-first, privacy-focused LLM frontend for roleplay. Characters, lorebooks and personas use SillyTavern's formats, so most existing libraries should import without trouble.

A chat is a tree rather than a line, so an edit or a regeneration branches instead of overwriting, and the story map lets you find your way around it.

## Download

**[Windows](https://github.com/patcireamo/ChungusHub/releases/latest)** · **[macOS (Apple Silicon)](https://github.com/patcireamo/ChungusHub/releases/latest)** · **[Linux](https://github.com/patcireamo/ChungusHub/releases/latest)**

Portable: unpack it and run it, nothing is installed and your data stays in the folder beside it.

The **[documentation](https://chungushub.mintlify.app/)** covers installing it, the first run and coming over from SillyTavern.

ChungusHub is under active development. So there might be some rough edges. Please do not hold back on bug reports, feature requests or plain feedback.

</div>

<h2 align="center">Showcase</h2>

<h3 align="center">Backgrounds & Ambient Effects</h3>

<div align="center">
  <img src="images/themes.gif" alt="The welcome screen cycling through palettes, backgrounds and ambient effects">

  <sub>Palettes, backgrounds and ambient effects over them. Everything is customizable.</sub>
</div>

<h3 align="center">Desktop</h3>

<table>
  <tr>
    <td align="center">
      <a href="images/screenshots/desktop_chat_bubbles.png"><img src="images/screenshots/desktop_chat_bubbles.png" alt="A chat in the Bubbles style, portraits beside each turn" width="400"></a><br>
      <sub>Bubbles</sub>
    </td>
    <td align="center">
      <a href="images/screenshots/desktop_chat_portraits.png"><img src="images/screenshots/desktop_chat_portraits.png" alt="The same chat in the Portraits style, one column with larger art" width="400"></a><br>
      <sub>Portraits</sub>
    </td>
  </tr>
  <tr>
    <td align="center">
      <a href="images/screenshots/desktop_lorebook.png"><img src="images/screenshots/desktop_lorebook.png" alt="A lorebook entry open, showing its keywords, filter and content" width="400"></a><br>
      <sub>Lorebook</sub>
    </td>
    <td align="center">
      <a href="images/screenshots/desktop_settings_and_library.png"><img src="images/screenshots/desktop_settings_and_library.png" alt="Settings docked on the left and the library on the right, either side of the workspace" width="400"></a><br>
      <sub>Settings and library on the sides</sub>
    </td>
  </tr>
</table>

<div align="center">
  <sub>Click a shot to open it full size.</sub>
</div>

<h3 align="center">Mobile</h3>

<div align="center">
  <img src="images/screenshots/mobile_welcome.png" alt="The welcome landing on a phone" width="250">
  <img src="images/screenshots/mobile_library.png" alt="The character library on a phone" width="250">
  <img src="images/screenshots/mobile_chat.png" alt="A chat on a phone" width="250">

  <sub>The landing, the library and a chat, on a phone.</sub>
</div>

<h2 align="center">Features</h2>

### Writing

- **Branching:** swipes, regenerations, edits and forks are all branches of one chat, so no version is ever lost.
- **Story Map:** see the whole tree on one canvas, name branches, mark one path as canon and jump into any turn.
- **Composer:** per-chat drafts sync across devices, and input history recalls what you sent.
- **Search:** find-in-chat searches every branch, and the chats panel finds and previews chats without opening them.

### Chungus Assistant

- **Workspace tools:** fixes character cards, edits chat messages, writes lorebooks and corrects chat memory.
- **Instructions and skills:** write your own to shape how it works.
- **Approval and capabilities:** choose whether it asks before acting and what it can reach.

### Story state

- **Character versions:** save a variant of a character without duplicating the whole card.
- **Lorebooks:** standalone, shareable, keyword-triggered world info in SillyTavern's own format, with scan and budget knobs.
- **Steering:** guidance notes that ride the prompt, scoped globally, per character or per chat.
- **Chat memory:** old scenes fold into summaries so long stories fit the context window, and each branch keeps its own.

### The prompt

- **Prompt Builder:** order, toggle and edit every block that becomes the prompt.
- **Preset Controls:** author-made controls that let users adjust a preset without opening the full prompt builder.
- **Preset cards:** a preset exports as a PNG, art on the front and the document inside, like a character card.
- **Prompt debug panel:** every request and response lands here, with token counts corrected against what the provider reported.

<p><br></p>

<div align="center">
  <img src="images/roadmap-banner.png" alt="Roadmap: what comes next">
</div>

<br>

- **Extension system:** third-party extensions communicate with the app through a versioned, permissioned API.
- **Image generation:** scene and character art from inside the app.
- **Text to speech:** spoken replies, so a scene can be listened to instead of read.
- **Group chat:** several characters in one scene, taking turns.
- **Visual novel mode:** a separate system that works nothing like normal character roleplay, turning a scene into a visual novel the model drives.

## On SillyTavern

ChungusHub owes SillyTavern more than a mention. I built it as a SillyTavern user, out of things I admired there and things I wanted to see work another way. It speaks SillyTavern's formats because that is the library people already have, mine included until I moved fully to ChungusHub.

This project is **not** a fork of SillyTavern and shares none of its code.

---

> [!NOTE]
> Everything below is about running ChungusHub from source and working on it. If you only want to use the app, the download above is all you need.

## Getting started

### Requirements

[Bun](https://bun.sh/) 1.3.9 or newer. That is the version the release builds are made with; older ones are untested.

```sh
# Windows (PowerShell)
powershell -c "irm bun.sh/install.ps1 | iex"

# Linux / macOS
curl -fsSL https://bun.sh/install | bash
```

### Run it

```sh
git clone https://github.com/patcireamo/ChungusHub.git
cd ChungusHub
bun install --frozen-lockfile
bun run start
```

Then open <http://localhost:4242>. Your data lives in `user-data/` next to the repo.

By default the app listens on loopback only. Turn on network access from Settings → Security when you want to reach it from other devices.

### Develop

Development runs as two processes, one per half of the app. Start them in separate terminals:

```sh
bun run server:dev   # server on :4242, restarts itself when server code changes
bun run dev          # client on :1420, hot reload
```

Then open <http://localhost:1420>.

`dev.ps1` on Windows and `dev.sh` on macOS and Linux do all of that in one window. `start.bat` and `start.command` are double-click wrappers for them.

`bun run check` type-checks the client and the server, and `bun test` runs the suite.

### Portable build

`bun run package` compiles a single executable with the Bun runtime embedded and lays it out in `dist/ChungusHub-portable/` with everything it needs beside it.

## Contributing

Contributions are welcome. For a larger change, open an issue first to discuss it before you spend the time; small fixes can come straight as a pull request.

1. Fork the project
2. Create your branch (`git checkout -b feature/my-feature`)
3. Commit your changes (`git commit -m 'feat: add my feature'`)
4. Push and open a pull request

Bug reports and feature requests through issues are worth just as much as code.

## License

Distributed under the GNU Affero General Public License v3.0. See [LICENSE](LICENSE).

The bundled typefaces are third-party and are not covered by that license. Each is under the SIL Open Font License, Version 1.1, and their copyright notices sit with them in [static/fonts/OFL.txt](static/fonts/OFL.txt).

The bundled notification sounds are third-party too and are not covered by that license either. Each is under CC0 1.0, CC BY 4.0 or CC BY 3.0, credited with them in [static/sounds/CREDITS.txt](static/sounds/CREDITS.txt).

The bundled ambient sounds are third-party as well and sit outside that license too. Each is under the Pixabay Content License or CC0 1.0, recorded with them in [defaults/sounds/CREDITS.txt](defaults/sounds/CREDITS.txt).

## Contact

Discord: **patcireamo**

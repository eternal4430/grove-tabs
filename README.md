# Grove: tree-style tabs for Chromium

A from-scratch Manifest V3 tab manager. It has no build step, no dependencies and no network access, and all its data stays in `chrome.storage`.

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick this folder.
3. Pin Grove to the toolbar. Click it, or press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd>, to open the panel.

**If the shortcut does nothing,** another extension (Bonsai, for one) already holds it. Chromium silently skips a suggested shortcut that's taken. Free it and assign it to Grove's "Open or close the Grove panel" at `chrome://extensions/shortcuts`.

## Features

- **Tree view:** tabs opened from another tab nest under it. Collapse branches; a badge shows how many tabs are hidden.
- **Floating panel:** a rounded overlay over the current page, opened from the toolbar button or the shortcut. It closes on <kbd>Esc</kbd>, on a click outside, or after you switch tabs. Dock it to the right or left side in the panel's ⋯ menu or in Settings; an open overlay moves straight away. Pages that block extensions (`chrome://`, the Web Store, the new-tab page) get a small standalone panel window docked to the same side instead, which stays open until you close it (Esc, or the toolbar button again). Injection uses `activeTab`, so Grove has no access to any site until you open the panel there.
- **Drag and drop:** drag by the grip. The top of a row drops above it, the bottom drops below, and the middle makes the tab a child. The list scrolls near its edges, and the whole subtree moves with the tab, across windows too.
- **Instant search:** filters by title and URL, matches every word you type, and keeps the parent tabs of each match so you can see where it sits.
- **Site exclusions:** listed domains, and their subdomains, stay out of the tree.
- **Recently closed tabs:** closed tabs stay in place as greyed-out rows with a countdown clock. Keep them for 12 h, 24 h, 3 days, 7 days or until you remove them. Click to reopen in the same spot.
- **Session snapshots:** save this window or all windows. Restore by replacing this window, opening a new window, adding to this window, or recreating the original windows. **Undo restore** reverses the last one. Snapshots can be exported to and imported from JSON.
- **Tab groups:** Chromium's own named, coloured groups (`chrome.tabGroups`), so they stay in sync with the tab strip. Groups show as tinted headers with a colour rail; click a header to collapse it, or right-click it (or use its ⋯ button) to rename it, pick one of the nine colours, add a new tab to it, move it to a new window, close it or ungroup it. Right-click a tab (or press <kbd>Shift</kbd>+<kbd>F10</kbd>, <kbd>G</kbd> in the list or <kbd>Alt</kbd>+<kbd>G</kbd> in search) to put it in a new or existing group, or take it out. Drop a tab on a group header to add it; drop it next to an ungrouped tab to take it out. Snapshots save and restore groups.
- **Houdini mode:** pages you visit while it's on are deleted from history as they load, and history from before stays untouched. The toolbar button shows an **H** badge while it's on. You can bind a shortcut to it.
- **Five themes:** Paper, Ink, Moss, Sakura and Slate, or follow the system light/dark setting.
- **Keyboard and screen readers:** the panel uses ARIA tree roles, with roving focus and spoken announcements. See the options page for all keys. Highlights: <kbd>Alt</kbd>+arrows move, indent and outdent tabs; <kbd>Delete</kbd> closes (add <kbd>Shift</kbd> for the whole subtree); <kbd>N</kbd> opens a child tab.

The tree survives service-worker restarts through `storage.session`. After a browser restart it's rebuilt by matching URLs against a saved copy of the tree.

### Hiding Chromium's own tab strip

Extensions can't hide or restyle the tab strip. Chromium 152+ can move it to the side instead: enable `chrome://flags/#vertical-tabs`, relaunch, right-click the tab strip and choose **Show tabs vertically**, then **Collapse tabs**. That leaves a narrow favicon rail in place of the top strip. Leave `#vertical-tabs-expand-on-hover` off so it doesn't pop open as the pointer passes.

### Tiling window managers

On Wayland, Chromium can't position its own windows, so the standalone panel window needs a compositor rule. Its title is `Grove panel (right) · <active tab title>` (or `(left)`); the tab title lets the hook find the browser window, whose title is `<active tab title> - Chromium`. For Hyprland 0.55+ (Lua config), [`contrib/hyprland-grove.lua`](contrib/hyprland-grove.lua) floats the window from the moment it maps (matching its class, `chrome-<extension id>-<profile>`, which is known before the title), keeps it invisible while a `window.title` hook docks it inside its browser window, then fades it in, so it never flashes as a tiled window. GNOME and KDE on Wayland would need their own equivalent; on X11, Windows and macOS Chromium positions it itself.

## Design

The visual system follows a command-palette style from [awesome-claude-design](https://github.com/VoltAgent/awesome-claude-design) (the Raycast `DESIGN.md`): a four-step surface ladder for depth, 1px hairline borders, 6–14px radii, Inter with the `ss03` stylistic set, and keycap-style shortcut hints. Tokens live in `themes.css`; Inter is bundled under `fonts/` (SIL OFL).

## Tests

```sh
node --test tests/            # pure tree logic
node tests/e2e.mjs chromium   # loads the extension into a throwaway headless profile
SHOTS=/tmp node tests/e2e.mjs chromium   # also saves a panel screenshot per theme
```

## License

MIT. See `LICENSE`. Inter is bundled under the SIL Open Font License (`fonts/Inter-OFL.txt`).

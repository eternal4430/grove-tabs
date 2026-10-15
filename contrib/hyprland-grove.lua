-- Grove panel window rules for Hyprland 0.55+ (Lua config).
--
-- On pages Chromium won't let extensions draw on (chrome://, the Web Store), Grove opens its
-- panel as a small standalone window. Wayland doesn't let Chromium place its own windows, so
-- this floats it from the moment it maps (no tiling flash), docks it inside the browser
-- window it belongs to, on the side chosen in Grove, and reveals it once it's in place.
--
-- Setup: replace both EXTENSION_ID occurrences with Grove's id (chrome://extensions, or the
-- class of its panel window in `hyprctl clients`: chrome-<id>-<profile>), then require or
-- paste this file into ~/.config/hypr/hyprland.lua and check `hyprctl configerrors`.

-- Grove (tree-style tab extension): on chrome:// pages its panel opens as a small
-- Chromium window titled "Grove panel (right)" or "Grove panel (left)". Float it inside
-- the browser window it came from, docked to that side, Bonsai-style. Chromium sets the
-- title only after the window maps, so this runs on title changes (which also re-docks
-- it when the side is switched). The panel window's class is chrome-<id>-<profile>, not
-- the browser's, so the browser is found by class prefix on the same workspace.
local grove_refs = {} -- panel address -> browser window address it docks into

-- The panel window's class is chrome-<extension id>-<profile> from the moment it opens,
-- unlike its title, so it can be caught before it's ever tiled: open it floating, sized,
-- unanimated and fully transparent, then reveal it once grove_place has docked it. If you
-- load Grove from a different folder its id changes; check `hyprctl clients` for the class.
local GROVE_CLASS = "^chrome%-EXTENSION_ID%-"
local grove_hidden = {} -- panel address -> true while waiting to be docked

hl.window_rule({
  match = { initial_class = "^chrome-EXTENSION_ID-.*$" },
  float = true,
  size = { 400, 660 },
  no_anim = true,
  opacity = "0 override 0 override",
})

local function grove_is_panel(w)
  return w ~= nil and w.class ~= nil and w.class:match(GROVE_CLASS) ~= nil
end

-- Reveal a beat after the move: the new position lands a frame after the dispatch, and
-- revealing at once can flash the window at its pre-dock spot.
function grove_reveal(w)
  if not grove_hidden[w.address] then return end
  grove_hidden[w.address] = nil
  local sel = "address:" .. w.address
  hl.timer(function()
    if hl.get_window(sel) then hl.dispatch(hl.dsp.window.set_prop({ prop = "opacity", value = "0.985 0.96", window = sel })) end
  end, { timeout = 60, type = "oneshot" })
end

-- Belt and braces for the static rule (in case the class lands just after the window maps),
-- plus a safety net: never leave a panel invisible if its title never arrives.
local function grove_catch(w)
  -- The class arrives before the window maps (no workspace yet); the static rule covers that
  -- moment, so only step in once it's mapped.
  if not grove_is_panel(w) or w.workspace == nil or grove_hidden[w.address] ~= nil then return end
  grove_hidden[w.address] = true
  local sel = "address:" .. w.address
  if not w.floating then hl.dispatch(hl.dsp.window.float({ action = "set", window = sel })) end
  hl.dispatch(hl.dsp.window.set_prop({ prop = "opacity", value = "0 override 0 override", window = sel }))
  hl.dispatch(hl.dsp.window.set_prop({ prop = "no_anim", value = "1", window = sel }))
  hl.timer(function()
    local now = hl.get_window(sel)
    if now and grove_hidden[now.address] then
      hl.dispatch(hl.dsp.window.center({ window = sel }))
      grove_reveal(now)
    end
  end, { timeout = 1500, type = "oneshot" })
end
hl.on("window.open", grove_catch)
hl.on("window.class", grove_catch)

local function grove_is_browser(cand, panel)
  return cand ~= nil
    and cand.address ~= panel.address
    and not cand.floating
    and tostring(cand.workspace) == tostring(panel.workspace)
    and cand.class ~= nil and cand.class:match("^chrom") ~= nil
    and not (cand.title or ""):match("^Grove panel")
end

local function grove_place(w)
  if w == nil or w.title == nil then return end
  local side = w.title:match("^Grove panel %((%a+)%)")
  if side ~= "left" and side ~= "right" then return end
  local sel = "address:" .. w.address

  -- Grove appends its browser window's active tab title ("Grove panel (right) · <tab>"),
  -- and Chromium titles browser windows "<tab> - Chromium", so match on that first.
  local ref
  local anchor = w.title:match("^Grove panel %(%a+%) · (.+)$")
  if anchor then
    for _, cand in ipairs(hl.get_windows()) do
      if grove_is_browser(cand, w) and cand.title:sub(1, #anchor + 3) == anchor .. " - " then
        ref = cand
        break
      end
    end
  end
  -- Otherwise fall back to the browser it docked into before, then to focus history
  -- (the browser it was opened from is focused, or was just before, when it appears).
  if ref == nil and grove_refs[w.address] then ref = hl.get_window("address:" .. grove_refs[w.address]) end
  if grove_is_browser(ref, w) then
    grove_refs[w.address] = ref.address
  else
    ref = nil
    for _, cand in ipairs({ hl.get_last_window(), hl.get_active_window() }) do
      if grove_is_browser(cand, w) then
        ref = cand
        break
      end
    end
    grove_refs[w.address] = ref and ref.address or nil
  end

  local box
  if ref then
    box = { x = ref.at.x, y = ref.at.y, w = ref.size.x, h = ref.size.y }
  else
    local m, r = w.monitor, w.monitor.reserved
    box = { x = m.x + r.left, y = m.y + r.top, w = m.width / m.scale - r.left - r.right, h = m.height / m.scale - r.top - r.bottom }
  end

  -- In 0.56 float "set" flips an already-floating window back to tiled, so only float once,
  -- and never resize a window that isn't floating (that would change the tiling split).
  if not w.floating then hl.dispatch(hl.dsp.window.float({ action = "set", window = sel })) end
  local now = hl.get_window(sel)
  if not (now and now.floating) then return end

  local width = math.min(400, math.floor(box.w - 24))
  local height = math.floor(math.max(320, math.min(660, box.h - 110)))
  local x = side == "left" and box.x + 12 or box.x + box.w - width - 12
  hl.dispatch(hl.dsp.window.resize({ x = width, y = height, window = sel }))
  hl.dispatch(hl.dsp.window.move({ x = math.floor(x), y = math.floor(box.y + 92), window = sel }))
  hl.dispatch(hl.dsp.window.set_prop({ prop = "rounding", value = "14", window = sel }))
  grove_reveal(w)
end
GrovePlace = grove_place -- callable from `hyprctl eval` to re-dock by hand
hl.on("window.title", grove_place)
hl.on("window.close", function(w)
  if w ~= nil then
    grove_refs[w.address] = nil
    grove_hidden[w.address] = nil
  end
end)

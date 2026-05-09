-- Read-only: batch can_place_entity check.
-- params.entities = [ { name|item, position:{x,y}, direction } ]
-- Returns { ok=true, results=[ { name, position, direction, canPlace,
--                               tile?, blockingEntities?, autoRotated? } ] }
--
-- Notes:
--   - Either `name` (entity prototype) or `item` (item-name with place_result)
--     is accepted. We prefer `name`; if missing/invalid, resolve via
--     prototypes.item[item].place_result.name (Factorio 2.0 API).
--   - Auto-rotate handling: offshore-pump (and any prototype whose `flags`
--     include "placeable-off-grid" + has fluidbox) auto-orients toward water
--     at place time. For these we treat canPlace=true if ANY of the 4
--     directions returns true; the chosen direction is reported back as
--     `autoRotatedDirection`. The runner can ignore the originally requested
--     direction in that case.

local DIRECTION_NAMES = { "north", "east", "south", "west" }
local DIRECTION_VALUES = {
  north = defines.direction.north,
  east  = defines.direction.east,
  south = defines.direction.south,
  west  = defines.direction.west,
}

local AUTO_ROTATE_NAMES = {
  ["offshore-pump"] = true,
}

local function resolve_entity_name(e)
  if e.name and prototypes.entity[e.name] then return e.name end
  if e.item then
    local proto = prototypes.item[e.item]
    if proto and proto.place_result then return proto.place_result.name end
  end
  return e.name or e.item
end

local function tile_name_at(surface, pos)
  local ok, tile = pcall(function() return surface.get_tile(math.floor(pos.x), math.floor(pos.y)) end)
  if ok and tile and tile.valid then return tile.name end
  return nil
end

local function find_blocking(surface, pos)
  local blocking = {}
  local area = {{ pos.x - 2, pos.y - 2 }, { pos.x + 2, pos.y + 2 }}
  for _, found in ipairs(surface.find_entities(area)) do
    if found.valid and found.name ~= "character" then
      blocking[#blocking + 1] = {
        name = found.name,
        position = { x = found.position.x, y = found.position.y },
      }
    end
  end
  return blocking
end

local function try_can_place(surface, name, pos, dir_name)
  local dir = DIRECTION_VALUES[dir_name] or defines.direction.north
  return surface.can_place_entity{
    name = name,
    position = pos,
    direction = dir,
    force = "player",
  }
end

return {
  query = function(params)
    local surface = game.player and game.player.surface or game.surfaces[1]
    local result = { ok = true, results = {} }
    for _, e in ipairs(params.entities or {}) do
      local pos = { x = e.position.x, y = e.position.y }
      local name = resolve_entity_name(e)
      local dir = e.direction or "north"
      local can_place = try_can_place(surface, name, pos, dir)
      local entry = {
        name = name,
        position = pos,
        direction = dir,
        canPlace = can_place,
      }
      if not can_place and AUTO_ROTATE_NAMES[name] then
        for _, alt in ipairs(DIRECTION_NAMES) do
          if alt ~= dir and try_can_place(surface, name, pos, alt) then
            can_place = true
            entry.canPlace = true
            entry.autoRotatedDirection = alt
            break
          end
        end
      end
      if not entry.canPlace then
        entry.tile = tile_name_at(surface, pos)
        entry.blockingEntities = find_blocking(surface, pos)
      end
      result.results[#result.results + 1] = entry
    end
    rcon.print(helpers.table_to_json(result))
  end
}

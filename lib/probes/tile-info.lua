-- Atomic tile/area inspector. Mirrors what the game UI shows on hover.
--
-- Single-point mode:  params = { x=<n>, y=<n> }
--   Returns tile type, all entities, all resources at that coordinate.
--
-- Area mode:  params = { area = { x1=<n>, y1=<n>, x2=<n>, y2=<n> } }
--   Returns all entities and resources in the rectangle.
--   Tile type is omitted (call single-point per tile if needed).
--
-- Response shape (both modes):
--   { ok, mode, entities=[...], resources=[...] }
--   entity:   { name, type, position, bounding_box, direction, health, status? }
--   resource: { name, position, amount }
--   point mode additionally: { tile, position }

return {
  query = function(params)
    local surface = game.player and game.player.surface or game.surfaces[1]
    local out = { ok = true }

    local function entity_row(e)
      if not e.valid then return nil end
      local row = {
        name     = e.name,
        type     = e.type,
        position = { x = e.position.x, y = e.position.y },
        direction = e.direction or 0,
        bounding_box = {
          left_top     = { x = e.bounding_box.left_top.x,     y = e.bounding_box.left_top.y },
          right_bottom = { x = e.bounding_box.right_bottom.x, y = e.bounding_box.right_bottom.y },
        },
        health = e.health,
      }
      -- status is only meaningful on machines
      if e.status ~= nil then
        row.status = e.status
      end
      return row
    end

    local function resource_row(e)
      if not e.valid then return nil end
      return {
        name     = e.name,
        position = { x = e.position.x, y = e.position.y },
        amount   = e.amount,
      }
    end

    if params and params.area then
      -- Area mode
      local a = params.area
      local bbox = { { a.x1, a.y1 }, { a.x2, a.y2 } }
      out.mode = "area"
      out.area = { x1 = a.x1, y1 = a.y1, x2 = a.x2, y2 = a.y2 }

      local entities  = {}
      local resources = {}
      for _, e in ipairs(surface.find_entities_filtered{ area = bbox }) do
        if e.type == "resource" then
          local r = resource_row(e)
          if r then resources[#resources + 1] = r end
        elseif e.name ~= "character" then
          local row = entity_row(e)
          if row then entities[#entities + 1] = row end
        end
      end
      out.entities  = entities
      out.resources = resources

    else
      -- Single-point mode
      local x = (params and params.x) or 0
      local y = (params and params.y) or 0
      out.mode     = "point"
      out.position = { x = x, y = y }

      local tile = surface.get_tile(x, y)
      out.tile = tile and tile.name or "unknown"

      -- Use a 1×1 bounding box centred on the tile centre
      local bbox = { { x - 0.5, y - 0.5 }, { x + 0.5, y + 0.5 } }
      local entities  = {}
      local resources = {}
      for _, e in ipairs(surface.find_entities_filtered{ area = bbox }) do
        if e.type == "resource" then
          local r = resource_row(e)
          if r then resources[#resources + 1] = r end
        elseif e.name ~= "character" then
          local row = entity_row(e)
          if row then entities[#entities + 1] = row end
        end
      end
      out.entities  = entities
      out.resources = resources
    end

    -- helpers.table_to_json serialises empty Lua tables as {} not [].
    -- Build the top-level JSON manually so array fields are always [].
    local function arr(t)
      if #t == 0 then return "[]" end
      return helpers.table_to_json(t)
    end

    if out.mode == "point" then
      rcon.print(string.format(
        '{"ok":true,"mode":"point","position":{"x":%g,"y":%g},"tile":"%s","entities":%s,"resources":%s}',
        out.position.x, out.position.y,
        out.tile,
        arr(out.entities),
        arr(out.resources)
      ))
    else
      rcon.print(string.format(
        '{"ok":true,"mode":"area","area":{"x1":%g,"y1":%g,"x2":%g,"y2":%g},"entities":%s,"resources":%s}',
        out.area.x1, out.area.y1, out.area.x2, out.area.y2,
        arr(out.entities),
        arr(out.resources)
      ))
    end
  end
}

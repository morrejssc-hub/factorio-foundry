-- Read-only: batch can_place_entity check.
-- params.entities = [ { name, position:{x,y}, direction } ]
-- Returns { ok=true, results=[ { name, position, direction, canPlace, blockingEntities? } ] }

return {
  query = function(params)
    local surface = game.player and game.player.surface or game.surfaces[1]
    local result = { ok = true, results = {} }
    for _, e in ipairs(params.entities or {}) do
      local pos = { x = e.position.x, y = e.position.y }
      local can_place = surface.can_place_entity{
        name = e.name,
        position = pos,
        direction = e.direction or defines.direction.north,
        force = "player",
      }
      local entry = {
        name = e.name,
        position = pos,
        direction = e.direction or 0,
        canPlace = can_place,
      }
      if not can_place then
        -- find what's blocking
        local blocking = {}
        local area = {
          { pos.x - 2, pos.y - 2 },
          { pos.x + 2, pos.y + 2 },
        }
        for _, found in ipairs(surface.find_entities(area)) do
          if found.valid and found.name ~= "character" then
            blocking[#blocking + 1] = {
              name = found.name,
              position = { x = found.position.x, y = found.position.y },
            }
          end
        end
        entry.blockingEntities = blocking
      end
      result.results[#result.results + 1] = entry
    end
    rcon.print(helpers.table_to_json(result))
  end
}

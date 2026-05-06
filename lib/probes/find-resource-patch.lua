-- Find resource tiles of any named ore near a center point.
-- params.resource defaults to "coal" so this is a strict superset of
-- find-coal-patch.lua. Use resource="iron-ore" for iron, "copper-ore" for
-- copper, "stone" for stone, etc.
return {
  query = function(params)
    local cx = (params and params.center_x) or 0
    local cy = (params and params.center_y) or 0
    local radius = (params and params.radius) or 50
    local resource = (params and params.resource) or "coal"

    local surface = game.surfaces[1]
    local area = {{cx - radius, cy - radius}, {cx + radius, cy + radius}}
    local resources = surface.find_entities_filtered{type = "resource", area = area, name = resource}

    local n = #resources
    local out = {}
    for i = 1, n do
      local entity = resources[i]
      out[i] = {x = entity.position.x, y = entity.position.y, amount = entity.amount, name = entity.name}
    end

    rcon.print(helpers.table_to_json({ok = true, resource = resource, count = n, resources = out}))
  end
}

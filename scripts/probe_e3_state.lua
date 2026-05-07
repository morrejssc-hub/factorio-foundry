return {
  query = function(params)
    local surface = game.surfaces[1]
    local radius = (params and params.radius) or 128
    local area = {{-radius, -radius}, {radius, radius}}
    local names = (params and params.resources) or {"coal", "iron-ore", "copper-ore", "stone"}
    local out = { ok = true, tick = game.tick, resources = {}, machines = {} }

    for _, name in pairs(names) do
      local ents = surface.find_entities_filtered{type = "resource", name = name, area = area}
      local count = #ents
      local total = 0
      local sx = 0
      local sy = 0
      local minx = nil
      local miny = nil
      local maxx = nil
      local maxy = nil
      local samples = {}
      for i, e in pairs(ents) do
        local x = e.position.x
        local y = e.position.y
        local a = e.amount or 0
        total = total + a
        sx = sx + x
        sy = sy + y
        if minx == nil or x < minx then minx = x end
        if miny == nil or y < miny then miny = y end
        if maxx == nil or x > maxx then maxx = x end
        if maxy == nil or y > maxy then maxy = y end
        if #samples < 12 then
          samples[#samples + 1] = {x = x, y = y, amount = a}
        end
      end
      local center = nil
      if count > 0 then center = {x = sx / count, y = sy / count} end
      out.resources[name] = {count = count, total_amount = total, center = center, bounds = {min = {x = minx, y = miny}, max = {x = maxx, y = maxy}}, samples = samples}
    end

    local machine_names = {"burner-mining-drill", "stone-furnace", "burner-inserter", "iron-chest", "transport-belt"}
    for _, name in pairs(machine_names) do
      local ents = surface.find_entities_filtered{name = name, area = area}
      local rows = {}
      for i, e in pairs(ents) do
        rows[#rows + 1] = {name = e.name, type = e.type, x = e.position.x, y = e.position.y, direction = e.direction}
      end
      out.machines[name] = rows
    end

    rcon.print(helpers.table_to_json(out))
  end
}

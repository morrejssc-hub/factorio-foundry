-- Atomic research / technology state inspector.
-- Returns completed technologies, current research progress, and all
-- recipes that are currently craftable by the player force.
-- No params required.
--
-- Response shape:
--   { ok, tick,
--     completed:  [tech_name, ...],
--     current:    { name, progress } | null,
--     recipes:    [{ name, category, ingredients:[{item,amount}], products:[{item,amount}] }]
--   }

return {
  query = function(_params)
    local force = game.forces.player
    local out   = { ok = true, tick = game.tick }

    -- Completed technologies
    local completed = {}
    for name, tech in pairs(force.technologies) do
      if tech.researched then
        completed[#completed + 1] = name
      end
    end
    table.sort(completed)
    -- Enabled recipes (craftable right now)
    local recipes = {}
    for name, recipe in pairs(force.recipes) do
      if recipe.enabled then
        local ings = {}
        for _, ing in ipairs(recipe.ingredients) do
          ings[#ings + 1] = { item = ing.name, amount = ing.amount }
        end
        local prods = {}
        for _, prod in ipairs(recipe.products) do
          prods[#prods + 1] = { item = prod.name, amount = prod.amount or 1 }
        end
        recipes[#recipes + 1] = {
          name        = name,
          category    = recipe.category,
          ingredients = ings,
          products    = prods,
        }
      end
    end
    table.sort(recipes, function(a, b) return a.name < b.name end)

    -- Serialize manually: empty arrays stay [], current is explicit null
    local function arr(t)
      if #t == 0 then return "[]" end
      return helpers.table_to_json(t)
    end

    local cur = force.current_research
    local current_json
    if cur then
      current_json = string.format('{"name":"%s","progress":%g}', cur.name, force.research_progress or 0)
    else
      current_json = "null"
    end

    rcon.print(string.format(
      '{"ok":true,"tick":%d,"completed":%s,"current":%s,"recipes":%s}',
      game.tick, arr(completed), current_json, arr(recipes)
    ))
  end
}

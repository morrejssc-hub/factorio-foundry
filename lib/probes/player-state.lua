-- Atomic player/worker state inspector.
-- Returns worker position, inventory contents, and walking reach.
-- No params required.
--
-- Response shape:
--   { ok, tick, worker: { position, inventory: [{item, count}] } }

return {
  query = function(_params)
    local surface = game.player and game.player.surface or game.surfaces[1]

    -- Find the tagged worker character
    local worker = nil
    for _, char in pairs(surface.find_entities_filtered{ name = "character" }) do
      if char.valid and char.name_tag == "factorio-agent-worker" then
        worker = char
        break
      end
    end

    local out = { ok = true, tick = game.tick }

    if not worker then
      out.worker = nil
      out.error  = "no factorio-agent-worker character found"
      rcon.print(helpers.table_to_json(out))
      return
    end

    -- Position
    local pos = { x = worker.position.x, y = worker.position.y }

    -- Inventory — Factorio 2.0: get_contents() returns [{name,quality,count}]
    local inv   = worker.get_inventory(defines.inventory.character_main)
    local items = {}
    if inv then
      for _, stack in ipairs(inv.get_contents()) do
        items[#items + 1] = { item = stack.name, count = stack.count }
      end
      table.sort(items, function(a, b) return a.item < b.item end)
    end

    -- Serialize manually so empty inventory stays []
    local function arr(t)
      if #t == 0 then return "[]" end
      return helpers.table_to_json(t)
    end
    rcon.print(string.format(
      '{"ok":true,"tick":%d,"worker":{"position":{"x":%g,"y":%g},"inventory":%s}}',
      game.tick, pos.x, pos.y, arr(items)
    ))
  end
}

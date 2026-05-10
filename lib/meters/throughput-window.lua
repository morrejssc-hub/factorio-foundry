-- throughput-window.lua
-- Deterministic meter: measure production rate of `item` over `window_ticks`.
-- Returns a single rcon.print line with JSON `{ok, item, measured, target,
-- pass, window_ticks, before, after}`.
--
-- Strategy:
--   1. Read LuaForce.get_item_production_statistics(surface).get_flow_count
--      with input=true → cumulative produced so far (a stable counter).
--   2. Wait `window_ticks` ticks via game.tick polling — but RCON commands
--      run synchronously inside one tick, so we can't sleep here. The
--      Node-side caller invokes this script twice (before and after) and
--      computes the delta itself; we just emit the snapshot.
return {
  query = function(params)
    params = params or {}
    local item = params.item or "coal"
    local force_name = params.force or "player"
    local surface_name = params.surface or "nauvis"
    local force = game.forces[force_name]
    local surface = game.surfaces[surface_name]
    if not force or not surface then
      rcon.print(helpers.table_to_json({ok = false, error = "missing force/surface"}))
      return
    end
    local stats = force.get_item_production_statistics(surface)
    local input_count = stats.get_input_count(item)  -- cumulative produced
    rcon.print(helpers.table_to_json({
      ok = true,
      item = item,
      tick = game.tick,
      cumulative_produced = input_count,
    }))
  end
}

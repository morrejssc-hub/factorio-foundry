-- power-window.lua
-- Audit: measure electric power production (kW) over a window.
-- Returns JSON `{ok, measured, tick}` where measured = cumulative energy (MJ)
-- produced so far. The Node-side caller invokes before/after and computes
-- the rate (kJ/s = kW) from the delta.
return {
  query = function(params)
    params = params or {}
    local force_name = params.force or "player"
    local surface_name = params.surface or "nauvis"
    local force = game.forces[force_name]
    local surface = game.surfaces[surface_name]
    if not force or not surface then
      rcon.print(helpers.table_to_json({ok = false, error = "missing force/surface"}))
      return
    end
    -- get_electric_network_info gives current stats of the connected grid.
    -- total_production = energy produced this tick (kJ/tick).
    local info = force.get_electric_network_info(surface)
    local total_production = info and info.total_production or 0
    local total_consumption = info and info.total_consumption or 0
    rcon.print(helpers.table_to_json({
      ok = true,
      tick = game.tick,
      cumulative_produced = total_production,
      cumulative_consumed = total_consumption,
    }))
  end
}

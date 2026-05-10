-- port-meter.lua
--
-- Unified port-attached meter. Replaces per-module meter scripts.
-- Branches on `port_kind` and reads from the corresponding Factorio
-- statistic. Returns the same {ok, tick, cumulative_produced} shape
-- that the Node-side runner already understands (observe.js readMeasured),
-- so before/after delta logic is shared with throughput-window.lua.
--
-- params:
--   port_kind     : "belt" | "pipe" | "power"
--   port_position : { x = number, y = number }   (world coords)
--   item          : factorio item id    (required for kind: belt)
--   fluid         : factorio fluid id   (required for kind: pipe)
--   force         : default "player"
--   surface       : default "nauvis"
--
-- Units of cumulative_produced:
--   belt  : items produced cumulatively (force-wide stat)
--   pipe  : fluid units produced cumulatively (force-wide stat)
--   power : kilojoules produced cumulatively (network local to the pole
--           found near port_position; converted from joules)
--
-- Power-only extras (snapshot, not cumulative):
--   max_kw    : nameplate generation capacity on the network in kW
--               (sum of generator.max_energy_production within 200 tiles
--               of the pole, filtered by electric_network_id)
--   stored_kj : current energy stored in accumulators on the network

local function emit(payload)
  rcon.print(helpers.table_to_json(payload))
end

local function find_pole_near(surface, pos, radius, force_name)
  -- Prefer a player-force pole (the module's own pole — its network
  -- carries actual production stats). The harness pole at the port is
  -- on verify-harness force and only sees the harness side until the
  -- harness setup wires it to the player network. Reading from a
  -- player-force pole avoids that timing window.
  local poles = surface.find_entities_filtered{
    type = "electric-pole",
    position = pos,
    radius = radius or 7.5,
    force = force_name or "player",
  }
  for _, p in ipairs(poles) do
    if p.valid then return p end
  end
  -- Fallback: any pole within radius. Catches edge cases where the
  -- only pole near the port is a harness pole already bridged to the
  -- player network.
  poles = surface.find_entities_filtered{
    type = "electric-pole",
    position = pos,
    radius = radius or 7.5,
  }
  for _, p in ipairs(poles) do
    if p.valid then return p end
  end
  return nil
end

return {
  query = function(params)
    params = params or {}
    local kind = params.port_kind
    local force_name = params.force or "player"
    local surface_name = params.surface or "nauvis"
    local force = game.forces[force_name]
    local surface = game.surfaces[surface_name]
    if not force or not surface then
      emit({ok = false, error = "missing force/surface"})
      return
    end

    if kind == "belt" then
      local item = params.item
      if not item then
        emit({ok = false, error = "kind=belt requires params.item"})
        return
      end
      local stats = force.get_item_production_statistics(surface)
      local count = stats.get_input_count(item)
      emit({
        ok = true,
        kind = kind,
        tick = game.tick,
        cumulative_produced = count,
        unit = "items",
      })
      return
    end

    if kind == "pipe" then
      local fluid = params.fluid or params.item
      if not fluid then
        emit({ok = false, error = "kind=pipe requires params.fluid"})
        return
      end
      local stats = force.get_fluid_production_statistics(surface)
      local count = stats.get_input_count(fluid)
      emit({
        ok = true,
        kind = kind,
        tick = game.tick,
        cumulative_produced = count,
        unit = "fluid",
      })
      return
    end

    if kind == "power" then
      local pos = params.port_position
      if not pos or pos.x == nil or pos.y == nil then
        emit({ok = false, error = "kind=power requires params.port_position={x,y}"})
        return
      end
      local pole = find_pole_near(surface, pos, 7.5, force_name)
      if not pole then
        emit({ok = false, error = "no electric-pole found within 7.5 tiles of port_position"})
        return
      end
      local stats = pole.electric_network_statistics
      if not stats then
        emit({ok = false, error = "pole has no electric_network_statistics (not on a network?)"})
        return
      end
      -- Sum cumulative joules across all generator types on the network.
      -- input_counts is a {prototype_name -> joules} table; values may be
      -- missing entirely until the first tick of production.
      local total_j = 0
      for _, count in pairs(stats.input_counts) do
        total_j = total_j + count
      end
      local total_kj = total_j / 1000

      -- Snapshot capacity + storage for the same network. We anchor the
      -- search at the pole and walk a 200-tile radius — wide enough to
      -- catch generators/accumulators wired into the steam plants we
      -- care about in early epochs, cheap enough to not stall the
      -- meter.  electric_network_id matches across the bridged
      -- harness/player networks once powerHarnessSetup wires them.
      local net_id = pole.electric_network_id
      local max_w = 0
      local stored_j = 0
      if net_id then
        local nearby_gens = surface.find_entities_filtered{
          type = "generator",
          position = pole.position,
          radius = 200,
        }
        for _, gen in ipairs(nearby_gens) do
          if gen.valid and gen.electric_network_id == net_id then
            -- Factorio 2.0: nameplate capacity is a method on the prototype
            -- (returns J/tick), not the property max_energy_production.
            local ok_prod, j_per_tick = pcall(function()
              return gen.prototype.get_max_energy_production()
            end)
            if ok_prod and j_per_tick then
              max_w = max_w + (j_per_tick * 60)
            end
          end
        end
        local nearby_accs = surface.find_entities_filtered{
          type = "accumulator",
          position = pole.position,
          radius = 200,
        }
        for _, acc in ipairs(nearby_accs) do
          if acc.valid and acc.electric_network_id == net_id then
            stored_j = stored_j + (acc.energy or 0)
          end
        end
      end
      local max_kw    = max_w / 1000
      local stored_kj = stored_j / 1000

      emit({
        ok = true,
        kind = kind,
        tick = game.tick,
        cumulative_produced = total_kj,
        unit = "kJ",
        max_kw = max_kw,
        stored_kj = stored_kj,
        pole_position = {x = pole.position.x, y = pole.position.y},
        pole_name = pole.name,
      })
      return
    end

    emit({ok = false, error = "unsupported port_kind: " .. tostring(kind)})
  end
}

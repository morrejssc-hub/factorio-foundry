-- port-power-check.lua — post-placement diagnostic for a module's port_pole.
--
-- Pivots on a single port_pole_position. Tells you:
--   1. Does the pole exist at that position?
--   2. Is its electric_network energized (any generator on the network)?
--   3. For each entity you ask about (or every electric entity nearby if you
--      don't pass a list): is it on the same electric_network as the pole?
--      If not, how far is it from the nearest pole that IS on the port's
--      network? That distance is the actionable signal for "add a pole here".
--
-- params:
--   port_pole_position = { x, y }          required
--   entities           = [ { id, position:{x,y} } ]   optional explicit list
--   scan_radius        = number            default 6; used when `entities` is
--                                          absent (auto-discover power-using
--                                          entities near the pole)
--   generator_radius   = number            default 200; how far to look for
--                                          generators on the port's network
--                                          when computing max_kw
--   surface            = string            default "nauvis"
--   force              = string            default "player"
--
-- Returns JSON:
--   {
--     ok = true,
--     port_pole = {
--       found, position, name, electric_network_id, max_kw, has_upstream_power,
--       supply_area_distance, maximum_wire_distance
--     },
--     network_poles = [ { position, name, supply_area_distance } ],
--     entities = [
--       { id, position, found, entity_name, electric_network_id,
--         on_port_network, nearest_pole_on_port_network = { position, distance } }
--     ],
--     uncovered = [ ... entities where on_port_network = false ],
--     summary = {
--       port_has_upstream_power, all_on_port_network, uncovered_count
--     }
--   }
--   On error (no pole at port_pole_position): { ok = false, error = "..." }

local POLE_FALLBACK = {
  ["small-electric-pole"]  = { supply = 2.5,  wire = 7.5  },
  ["medium-electric-pole"] = { supply = 3.5,  wire = 9.0  },
  ["big-electric-pole"]    = { supply = 2.0,  wire = 30.0 },
  ["substation"]           = { supply = 9.0,  wire = 18.0 },
}

local function proto_number(entity, fields, fallback)
  for _, field in ipairs(fields) do
    local ok, value = pcall(function() return entity.prototype[field] end)
    if ok and type(value) == "number" then return value end
  end
  return fallback
end

local function pole_supply_distance(pole)
  local fb = POLE_FALLBACK[pole.name] or { supply = 0, wire = 0 }
  return proto_number(pole, {"supply_area_distance"}, fb.supply)
end

local function pole_wire_distance(pole)
  local fb = POLE_FALLBACK[pole.name] or { supply = 0, wire = 0 }
  return proto_number(pole, {"maximum_wire_distance", "max_wire_distance"}, fb.wire)
end

local function distance(a, b)
  local dx = (a.x or 0) - (b.x or 0)
  local dy = (a.y or 0) - (b.y or 0)
  return math.sqrt(dx * dx + dy * dy)
end

local function find_pole_at(surface, force, pos)
  -- Try increasing radii: 0.6 (exact tile), 1.0 (1-tile slop), 1.5 (2-tile slop).
  -- Small variations cover entities that snap slightly off the requested anchor
  -- (e.g. half-tile alignment for 2x2 poles).
  for _, r in ipairs({0.6, 1.0, 1.5}) do
    local hits = surface.find_entities_filtered{
      type = "electric-pole",
      force = force,
      position = { x = pos.x or 0, y = pos.y or 0 },
      radius = r,
    }
    for _, e in ipairs(hits) do
      if e.valid then return e end
    end
  end
  return nil
end

local function scan_nearby_poles(surface, force, pos, radius)
  local cx, cy = pos.x or 0, pos.y or 0
  local hits = surface.find_entities_filtered{
    type = "electric-pole",
    force = force,
    area = {{ cx - radius, cy - radius }, { cx + radius, cy + radius }},
  }
  local out = {}
  for _, e in ipairs(hits) do
    if e.valid then
      out[#out + 1] = {
        position = { x = e.position.x, y = e.position.y },
        name = e.name,
        electric_network_id = e.electric_network_id,
        distance = math.sqrt((e.position.x - cx)^2 + (e.position.y - cy)^2),
      }
    end
  end
  table.sort(out, function(a, b) return a.distance < b.distance end)
  return out
end

local function entities_at(surface, force, pos)
  local hits = surface.find_entities_filtered{
    force = force,
    position = { x = pos.x or 0, y = pos.y or 0 },
    radius = 0.6,
  }
  local out = {}
  for _, e in ipairs(hits) do
    if e.valid then
      out[#out + 1] = {
        name = e.name,
        type = e.type,
        position = { x = e.position.x, y = e.position.y },
      }
    end
  end
  return out
end

local function network_max_kw(surface, pole, generator_radius)
  local net_id = pole.electric_network_id
  if not net_id then return 0 end
  local max_w = 0
  local gens = surface.find_entities_filtered{
    type = "generator",
    position = pole.position,
    radius = generator_radius,
  }
  for _, gen in ipairs(gens) do
    if gen.valid and gen.electric_network_id == net_id then
      local ok_prod, j_per_tick = pcall(function()
        return gen.prototype.get_max_energy_production()
      end)
      if ok_prod and type(j_per_tick) == "number" then
        max_w = max_w + (j_per_tick * 60)
      else
        local ok_field, value = pcall(function() return gen.prototype.max_energy_production end)
        if ok_field and type(value) == "number" then max_w = max_w + value end
      end
    end
  end
  return max_w / 1000
end

local function poles_on_network(surface, force, port_pole, scan_radius)
  local net_id = port_pole.electric_network_id
  if not net_id then return {} end
  local cx, cy = port_pole.position.x, port_pole.position.y
  -- Use wire reach * 8 as a generous scan box. For small poles that's 60
  -- tiles; for substations 144. Wire chains longer than this would be
  -- unusual for a single module's grid.
  local box = math.max(scan_radius or 0, pole_wire_distance(port_pole) * 8)
  local found = surface.find_entities_filtered{
    type = "electric-pole",
    force = force,
    area = {{ cx - box, cy - box }, { cx + box, cy + box }},
  }
  local out = {}
  for _, p in ipairs(found) do
    if p.valid and p.electric_network_id == net_id then
      out[#out + 1] = {
        position = { x = p.position.x, y = p.position.y },
        name = p.name,
        supply_area_distance = pole_supply_distance(p),
      }
    end
  end
  return out
end

local function find_entity_at(surface, force, pos)
  -- find any entity at the exact tile; prefer ones with an electric_network_id
  -- so we don't return adjacent belts when the caller meant the assembler.
  local hits = surface.find_entities_filtered{
    position = { x = pos.x or 0, y = pos.y or 0 },
    radius = 0.6,
    force = force,
  }
  local best = nil
  for _, e in ipairs(hits) do
    if e.valid then
      local has_net = false
      local ok, net = pcall(function() return e.electric_network_id end)
      if ok and type(net) == "number" then has_net = true end
      if has_net then return e end
      if not best then best = e end
    end
  end
  return best
end

local function auto_discover_entities(surface, force, port_pole, scan_radius)
  local cx, cy = port_pole.position.x, port_pole.position.y
  local found = surface.find_entities_filtered{
    force = force,
    area = {{ cx - scan_radius, cy - scan_radius }, { cx + scan_radius, cy + scan_radius }},
  }
  local out = {}
  for _, e in ipairs(found) do
    if e.valid and e.type ~= "electric-pole" then
      local ok, net = pcall(function() return e.electric_network_id end)
      if ok and type(net) == "number" then
        out[#out + 1] = {
          id = (e.unit_number and ("u" .. e.unit_number)) or (e.name .. "@" .. e.position.x .. "," .. e.position.y),
          position = { x = e.position.x, y = e.position.y },
          _entity = e,
        }
      end
    end
  end
  return out
end

local function nearest_port_network_pole(network_poles, pos)
  local nearest = nil
  for _, p in ipairs(network_poles) do
    local d = distance(p.position, pos)
    if (not nearest) or d < nearest.distance then
      nearest = { position = p.position, distance = d, name = p.name }
    end
  end
  return nearest
end

return {
  query = function(params)
    params = params or {}
    local surface_name = params.surface or "nauvis"
    local force_name = params.force or "player"
    local surface = game.surfaces[surface_name] or game.surfaces[1]
    local force = game.forces[force_name] or game.forces["player"]
    local scan_radius = params.scan_radius or 6
    local generator_radius = params.generator_radius or 200

    local port_pos = params.port_pole_position or {}
    local port_pole = find_pole_at(surface, force, port_pos)
    if not port_pole then
      -- Diagnostic: what's actually nearby? Help the caller distinguish
      -- "blueprint never placed a pole" (no poles within 10 tiles) from
      -- "pole landed offset" (a pole shows up 2-3 tiles away).
      local nearby = scan_nearby_poles(surface, force, port_pos, 15)
      local present = entities_at(surface, force, port_pos)
      rcon.print(helpers.table_to_json({
        ok = false,
        error = "no electric-pole found at port_pole_position",
        port_pole_position = { x = port_pos.x, y = port_pos.y },
        nearby_poles = nearby,
        entities_at_position = present,
      }))
      return
    end

    local port_net_id = port_pole.electric_network_id
    local max_kw = network_max_kw(surface, port_pole, generator_radius)
    local port_info = {
      found = true,
      position = { x = port_pole.position.x, y = port_pole.position.y },
      name = port_pole.name,
      electric_network_id = port_net_id,
      max_kw = max_kw,
      has_upstream_power = max_kw > 0,
      supply_area_distance = pole_supply_distance(port_pole),
      maximum_wire_distance = pole_wire_distance(port_pole),
    }

    local network_poles = poles_on_network(surface, force, port_pole, scan_radius)

    -- Build entity check list. Explicit list wins; else auto-discover.
    local checks = {}
    if params.entities and #params.entities > 0 then
      for _, e in ipairs(params.entities) do
        local pos = e.position or {}
        local found_e = find_entity_at(surface, force, pos)
        checks[#checks + 1] = {
          id = e.id or ("entity-" .. (#checks + 1)),
          position = { x = pos.x or 0, y = pos.y or 0 },
          _entity = found_e,
        }
      end
    else
      checks = auto_discover_entities(surface, force, port_pole, scan_radius)
    end

    local entity_results = {}
    local uncovered = {}
    local skipped_non_electric = {}
    for _, c in ipairs(checks) do
      local e = c._entity
      if not e then
        -- Entity wasn't placed where we expected — that's a real failure
        -- to surface (different from "not electric").
        local entry = {
          id = c.id,
          position = c.position,
          found = false,
          on_port_network = false,
          reason = "entity_not_found",
          nearest_pole_on_port_network = nearest_port_network_pole(network_poles, c.position),
        }
        entity_results[#entity_results + 1] = entry
        uncovered[#uncovered + 1] = entry
      else
        local ok, net = pcall(function() return e.electric_network_id end)
        local net_id = (ok and type(net) == "number") and net or nil
        if net_id == nil then
          -- belts, burner-inserters, chests, etc — not power-relevant.
          skipped_non_electric[#skipped_non_electric + 1] = {
            id = c.id, position = c.position, entity_name = e.name,
          }
        else
          local on_net = (net_id == port_net_id) and (port_net_id ~= nil)
          local entry = {
            id = c.id,
            position = c.position,
            found = true,
            entity_name = e.name,
            electric_network_id = net_id,
            on_port_network = on_net,
          }
          if not on_net then
            entry.nearest_pole_on_port_network = nearest_port_network_pole(network_poles, c.position)
          end
          entity_results[#entity_results + 1] = entry
          if not on_net then
            uncovered[#uncovered + 1] = entry
          end
        end
      end
    end

    local all_on = true
    for _, r in ipairs(entity_results) do
      if not r.on_port_network then all_on = false; break end
    end

    rcon.print(helpers.table_to_json({
      ok = true,
      port_pole = port_info,
      network_poles = network_poles,
      entities = entity_results,
      uncovered = uncovered,
      skipped_non_electric = skipped_non_electric,
      summary = {
        port_has_upstream_power = port_info.has_upstream_power,
        all_on_port_network = all_on,
        uncovered_count = #uncovered,
        network_pole_count = #network_poles,
      },
    }))
  end
}

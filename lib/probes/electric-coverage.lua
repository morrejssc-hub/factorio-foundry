-- Read-only electric coverage probe.
--
-- params:
--   radius = scan radius around checks (default 80)
--   generator_radius = scan radius from each pole for generators (default 200)
--   points = [{ id, position:{x,y} }]
--   entities = [{ id, placementId, entityKey, name|item, position:{x,y}, requires_power? }]
--
-- Returns:
--   {
--     ok=true,
--     poles=[...],
--     checks=[{ id, position, requiresPower, covered, powered,
--               coveredBy=[...], poweredBy=[...],
--               nearestPole, nearestPoweredPole }],
--     uncovered=[...] -- requiresPower checks not covered by powered network
--   }

local POLE_FALLBACK = {
  ["small-electric-pole"]  = { supply = 2.5,  wire = 7.5  },
  ["medium-electric-pole"] = { supply = 3.5,  wire = 9.0  },
  ["big-electric-pole"]    = { supply = 2.0,  wire = 30.0 },
  ["substation"]           = { supply = 9.0,  wire = 18.0 },
}

local NON_POWERED = {
  ["burner-inserter"] = true,
  ["burner-mining-drill"] = true,
  ["stone-furnace"] = true,
  ["steel-furnace"] = true,
  ["boiler"] = true,
  ["offshore-pump"] = true,
  ["transport-belt"] = true,
  ["fast-transport-belt"] = true,
  ["express-transport-belt"] = true,
  ["underground-belt"] = true,
  ["splitter"] = true,
  ["pipe"] = true,
  ["wooden-chest"] = true,
  ["iron-chest"] = true,
  ["steel-chest"] = true,
}

local ELECTRIC_NAMES = {
  ["assembling-machine-1"] = true,
  ["assembling-machine-2"] = true,
  ["assembling-machine-3"] = true,
  ["electric-mining-drill"] = true,
  ["electric-furnace"] = true,
  ["inserter"] = true,
  ["fast-inserter"] = true,
  ["long-handed-inserter"] = true,
  ["filter-inserter"] = true,
  ["lab"] = true,
  ["radar"] = true,
  ["small-lamp"] = true,
  ["pump"] = true,
  ["beacon"] = true,
  ["roboport"] = true,
}

local ELECTRIC_TYPES = {
  ["assembling-machine"] = true,
  ["inserter"] = true,
  ["lab"] = true,
  ["lamp"] = true,
  ["mining-drill"] = true,
  ["pump"] = true,
  ["radar"] = true,
  ["roboport"] = true,
  ["beacon"] = true,
}

local function resolve_entity_name(e)
  if e.name and prototypes.entity[e.name] then return e.name end
  if e.item then
    local proto = prototypes.item[e.item]
    if proto and proto.place_result then return proto.place_result.name end
  end
  return e.name or e.item or "unknown"
end

local function prototype_type(name)
  local ok, value = pcall(function()
    return prototypes.entity[name] and prototypes.entity[name].type
  end)
  if ok then return value end
  return nil
end

local function requires_power(e, name)
  if e.requiresPower ~= nil then return e.requiresPower == true end
  if e.requires_power ~= nil then return e.requires_power == true end
  if NON_POWERED[name] then return false end
  if ELECTRIC_NAMES[name] then return true end
  local t = prototype_type(name)
  if ELECTRIC_TYPES[t] and not NON_POWERED[name] then return true end
  return false
end

local function proto_number(entity, fields, fallback)
  for _, field in ipairs(fields) do
    local ok, value = pcall(function() return entity.prototype[field] end)
    if ok and type(value) == "number" then return value end
  end
  return fallback
end

local function distance(a, b)
  local dx = (a.x or 0) - (b.x or 0)
  local dy = (a.y or 0) - (b.y or 0)
  return math.sqrt(dx * dx + dy * dy)
end

local function pole_supply_distance(pole)
  local fb = POLE_FALLBACK[pole.name] or { supply = 0, wire = 0 }
  return proto_number(pole, {"supply_area_distance"}, fb.supply)
end

local function pole_wire_distance(pole)
  local fb = POLE_FALLBACK[pole.name] or { supply = 0, wire = 0 }
  return proto_number(pole, {"maximum_wire_distance", "max_wire_distance"}, fb.wire)
end

local function covered_by_pole(pole, pos)
  local supply = pole_supply_distance(pole)
  return math.abs((pos.x or 0) - pole.position.x) <= supply
     and math.abs((pos.y or 0) - pole.position.y) <= supply
end

local function network_capacity_kw(surface, pole, cache, generator_radius)
  local net_id = pole.electric_network_id
  if not net_id then return 0 end
  local key = tostring(net_id)
  if cache[key] ~= nil then return cache[key] end

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
        local ok_field, value = pcall(function()
          return gen.prototype.max_energy_production
        end)
        if ok_field and type(value) == "number" then
          max_w = max_w + value
        end
      end
    end
  end

  cache[key] = max_w / 1000
  return cache[key]
end

local function pole_row(pole, max_kw)
  local supply = pole_supply_distance(pole)
  local wire = pole_wire_distance(pole)
  return {
    name = pole.name,
    unitNumber = pole.unit_number,
    position = { x = pole.position.x, y = pole.position.y },
    electricNetworkId = pole.electric_network_id,
    supplyAreaDistance = supply,
    maximumWireDistance = wire,
    maxKw = max_kw,
    powered = max_kw > 0,
    coverageBox = {
      leftTop = { x = pole.position.x - supply, y = pole.position.y - supply },
      rightBottom = { x = pole.position.x + supply, y = pole.position.y + supply },
    },
  }
end

local function slim_pole(row, pos)
  return {
    name = row.name,
    unitNumber = row.unitNumber,
    position = row.position,
    electricNetworkId = row.electricNetworkId,
    maxKw = row.maxKw,
    distance = distance(row.position, pos),
  }
end

return {
  query = function(params)
    params = params or {}
    local surface = game.surfaces[params.surface or "nauvis"] or game.surfaces[1]
    local force = game.forces[params.force or "player"] or game.forces["player"]
    local radius = params.radius or 80
    local generator_radius = params.generator_radius or 200

    local checks = {}
    for _, point in ipairs(params.points or {}) do
      local pos = point.position or {}
      checks[#checks + 1] = {
        id = point.id or ("point-" .. tostring(#checks + 1)),
        name = point.name or "point",
        position = { x = pos.x or 0, y = pos.y or 0 },
        requiresPower = true,
      }
    end
    for _, entity in ipairs(params.entities or {}) do
      local pos = entity.position or {}
      local name = resolve_entity_name(entity)
      local id = entity.id
        or ((entity.placementId and entity.entityKey) and (entity.placementId .. ":" .. entity.entityKey))
        or name
      checks[#checks + 1] = {
        id = id,
        name = name,
        position = { x = pos.x or 0, y = pos.y or 0 },
        requiresPower = requires_power(entity, name),
      }
    end

    local cx = params.center_x or 0
    local cy = params.center_y or 0
    local min_x, min_y = cx - radius, cy - radius
    local max_x, max_y = cx + radius, cy + radius
    if #checks > 0 then
      min_x, min_y = checks[1].position.x, checks[1].position.y
      max_x, max_y = checks[1].position.x, checks[1].position.y
      for _, c in ipairs(checks) do
        min_x = math.min(min_x, c.position.x)
        min_y = math.min(min_y, c.position.y)
        max_x = math.max(max_x, c.position.x)
        max_y = math.max(max_y, c.position.y)
      end
      min_x, min_y = min_x - radius, min_y - radius
      max_x, max_y = max_x + radius, max_y + radius
    end

    local cache = {}
    local poles = {}
    local raw_poles = surface.find_entities_filtered{
      type = "electric-pole",
      force = force,
      area = {{ min_x, min_y }, { max_x, max_y }},
    }
    for _, pole in ipairs(raw_poles) do
      if pole.valid then
        local row = pole_row(pole, network_capacity_kw(surface, pole, cache, generator_radius))
        poles[#poles + 1] = row
      end
    end

    table.sort(poles, function(a, b)
      if a.position.x == b.position.x then return a.position.y < b.position.y end
      return a.position.x < b.position.x
    end)

    local result_checks = {}
    local uncovered = {}
    for _, c in ipairs(checks) do
      local covered_by = {}
      local powered_by = {}
      local nearest = nil
      local nearest_powered = nil

      for _, row in ipairs(poles) do
        local slim = slim_pole(row, c.position)
        if (not nearest) or slim.distance < nearest.distance then
          nearest = slim
        end
        if row.powered and ((not nearest_powered) or slim.distance < nearest_powered.distance) then
          nearest_powered = slim
        end
        if math.abs(c.position.x - row.position.x) <= row.supplyAreaDistance
          and math.abs(c.position.y - row.position.y) <= row.supplyAreaDistance then
          covered_by[#covered_by + 1] = slim
          if row.powered then powered_by[#powered_by + 1] = slim end
        end
      end

      table.sort(covered_by, function(a, b) return a.distance < b.distance end)
      table.sort(powered_by, function(a, b) return a.distance < b.distance end)

      local entry = {
        id = c.id,
        name = c.name,
        position = c.position,
        requiresPower = c.requiresPower,
        covered = #covered_by > 0,
        powered = #powered_by > 0,
        coveredBy = covered_by,
        poweredBy = powered_by,
        nearestPole = nearest,
        nearestPoweredPole = nearest_powered,
      }
      result_checks[#result_checks + 1] = entry
      if c.requiresPower and not entry.powered then
        uncovered[#uncovered + 1] = entry
      end
    end

    rcon.print(helpers.table_to_json({
      ok = true,
      query = "electric_coverage",
      radius = radius,
      generatorRadius = generator_radius,
      scanArea = { leftTop = { x = min_x, y = min_y }, rightBottom = { x = max_x, y = max_y } },
      poles = poles,
      checks = result_checks,
      uncovered = uncovered,
    }))
  end
}

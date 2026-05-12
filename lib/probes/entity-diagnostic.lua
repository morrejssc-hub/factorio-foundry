-- entity-diagnostic.lua — post-meter-window diagnostic for the observe phase.
--
-- For each placement footprint, scan every entity whose prototype exposes a
-- `status` field (assemblers, furnaces, inserters, mining drills, labs,
-- pumps, boilers, generators, electric poles, ...) and return its
-- defines.entity_status mapped to a string ("working", "no_ingredients",
-- "no_power", "full_output", ...) plus type-specific extras
-- (electric_network_id, energy, recipe, crafting state). Belts / pipes /
-- chests have no status and are skipped automatically.
--
-- The caller (src/runner/observe.js) passes axis-aligned world-space bboxes
-- derived from each placement's anchor + module.footprint. We inflate each
-- bbox by 1 tile to absorb half-tile entity centers and minor rotation slop.
--
-- params:
--   footprints = [
--     { id = "p0", module = "...", bbox = { min = {x,y}, max = {x,y} } },
--     ...
--   ]
--   surface = string  default "nauvis"
--   force   = string  default "player"
--
-- Returns JSON:
--   {
--     ok = true,
--     footprints = [
--       {
--         id, module, bbox,
--         entities = [
--           { unit_number, name, type, position, status, status_code,
--             electric_network_id?, energy?, crafting_progress?,
--             is_crafting?, recipe? }
--         ],
--         by_status = { <status_name> = <count>, ... },
--         issues    = [ { name, position, status } ]  -- non-OK entries
--       }
--     ],
--     summary = { total_entities, issue_count, statuses_seen = [string,...] }
--   }
--   Errors surface as { ok = false, error = "..." }.

local BBOX_INFLATE = 1

-- "OK" statuses — entity is not in a fault state. Everything else flows into
-- `issues` so the next phase (and ultimately Designer) can root-cause.
local OK_STATUSES = {
  working = true,
  normal = true,
  fully_charged = true,
  charging = true,
  discharging = true,
}

-- Build a number → name reverse map of defines.entity_status once per call.
-- Factorio guarantees this enum is stable; we don't cache across calls.
local function build_status_name_map()
  local out = {}
  if defines and defines.entity_status then
    for name, code in pairs(defines.entity_status) do
      out[code] = name
    end
  end
  return out
end

local function pcall_get(entity, field)
  local ok, value = pcall(function() return entity[field] end)
  if ok then return value end
  return nil
end

local function pcall_call(entity, method)
  local ok, value = pcall(function() return entity[method](entity) end)
  if ok then return value end
  return nil
end

local function entity_row(entity, status_names)
  local code = pcall_get(entity, "status")
  if type(code) ~= "number" then return nil end

  local name = status_names[code] or ("status_" .. tostring(code))
  local row = {
    unit_number = entity.unit_number,
    name = entity.name,
    type = entity.type,
    position = { x = entity.position.x, y = entity.position.y },
    status = name,
    status_code = code,
  }

  local net = pcall_get(entity, "electric_network_id")
  if type(net) == "number" then row.electric_network_id = net end

  local energy = pcall_get(entity, "energy")
  if type(energy) == "number" then row.energy = energy end

  local progress = pcall_get(entity, "crafting_progress")
  if type(progress) == "number" then row.crafting_progress = progress end

  local crafting = pcall_get(entity, "is_crafting")
  if type(crafting) == "boolean" then row.is_crafting = crafting end

  local recipe = pcall_call(entity, "get_recipe")
  if recipe and recipe.name then row.recipe = recipe.name end

  return row
end

return {
  query = function(params)
    params = params or {}
    local surface = game.surfaces[params.surface or "nauvis"] or game.surfaces[1]
    local force = game.forces[params.force or "player"] or game.forces["player"]
    if not surface then
      rcon.print(helpers.table_to_json({ ok = false, error = "no surface" }))
      return
    end

    local status_names = build_status_name_map()
    local footprints_in = params.footprints or {}
    local footprints_out = {}
    local total_entities = 0
    local issue_count = 0
    local statuses_seen = {}

    for _, fp in ipairs(footprints_in) do
      local bbox = fp.bbox or {}
      local mn = bbox.min or {}
      local mx = bbox.max or {}
      local area = {
        { (mn.x or 0) - BBOX_INFLATE, (mn.y or 0) - BBOX_INFLATE },
        { (mx.x or 0) + BBOX_INFLATE, (mx.y or 0) + BBOX_INFLATE },
      }

      local found = surface.find_entities_filtered{
        force = force,
        area = area,
      }

      local rows = {}
      local by_status = {}
      local issues = {}
      for _, e in ipairs(found) do
        if e.valid then
          local row = entity_row(e, status_names)
          if row then
            rows[#rows + 1] = row
            by_status[row.status] = (by_status[row.status] or 0) + 1
            statuses_seen[row.status] = true
            if not OK_STATUSES[row.status] then
              issue_count = issue_count + 1
              issues[#issues + 1] = {
                name = row.name,
                position = row.position,
                status = row.status,
              }
            end
          end
        end
      end
      total_entities = total_entities + #rows

      footprints_out[#footprints_out + 1] = {
        id = fp.id,
        module = fp.module,
        bbox = bbox,
        entities = rows,
        by_status = by_status,
        issues = issues,
      }
    end

    local seen_list = {}
    for s, _ in pairs(statuses_seen) do seen_list[#seen_list + 1] = s end
    table.sort(seen_list)

    rcon.print(helpers.table_to_json({
      ok = true,
      footprints = footprints_out,
      summary = {
        total_entities = total_entities,
        issue_count = issue_count,
        statuses_seen = seen_list,
      },
    }))
  end
}

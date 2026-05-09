-- find-placement-anchors.lua
--
-- Discovery probe: given an entity prototype + region, returns a set of
-- legal (position, directions) anchors where surface.can_place_entity
-- returns true. Complements validate-placement.lua, which verifies a
-- specific set of placements; this one *enumerates* candidates.
--
-- Three filter layers:
--   1. Terrain — surface.can_place_entity is the primitive. Optional
--      "blocked-by-clearable" branch reports tiles blocked only by
--      trees/rocks/fish, with a needs_clearing list so the runner can
--      plan a clear-then-place sequence.
--   2. Region — bbox clipping (params.region accepts {left_top,
--      right_bottom} or {center, radius}).
--   3. Direction — for each (x, y) we test all applicable directions and
--      group results: one candidate per position carries the list of
--      directions that worked. For prototypes whose footprint is
--      direction-symmetric this naturally collapses to a single entry
--      with directions=["north","east","south","west"] (the agent picks
--      the one matching its layout).
--
-- Two modes:
--   raw  → scan the full bbox interior. Best for area/point-set use cases
--          (mining-drill on a coal patch, pumpjack on an oil patch).
--   edge → scan only the bbox perimeter (one-tile-thick frame). Best for
--          edge-attached entities (offshore-pump on a water patch — pass
--          the water-patch bbox plus a 1-tile inflate so the perimeter
--          straddles the shoreline).
--
-- Result-bloat mitigation:
--   max_results (default 32, hard cap 256) + sort_by determines which
--   candidates survive truncation. total_found reports the pre-truncate
--   count so the agent knows how many are unseen.
--
-- Params:
--   entity        : prototype name (required), e.g. "offshore-pump"
--   region        : { left_top:{x,y}, right_bottom:{x,y} } OR
--                   { center:{x,y}, radius:n }
--   mode          : "raw" | "edge" (default "raw")
--   max_results   : default 32, capped at 256
--   sort_by       : "centroid_distance" (default) | "raster"
--   directions    : optional override, subset of north/east/south/west
--   include_blocked_by_clearable : default false; when true also returns
--                   anchors blocked only by trees/rocks with needs_clearing
--   force         : default "player"
--   surface       : default "nauvis"
--
-- Output:
--   {
--     ok = true,
--     entity, mode,
--     candidates = [{
--       position = {x,y},
--       directions = ["north","east",...],     -- always an array
--       status = "free" | "needs_clearing",
--       needs_clearing = [{name,type,position}]?,
--     }, ...],
--     total_found,            -- before truncation
--     returned,               -- after truncation
--     scanned_tiles,
--   }

local DIRECTION_NAMES = { "north", "east", "south", "west" }
local DIRECTION_VALUES = {
  north = defines.direction.north,
  east  = defines.direction.east,
  south = defines.direction.south,
  west  = defines.direction.west,
}

local CLEARABLE_TYPES = {
  ["tree"]          = true,
  ["simple-entity"] = true,  -- rocks
  ["fish"]          = true,
}

local SCAN_HARD_CAP = 50000  -- emergency brake on can_place_entity calls

local function applicable_directions(override)
  if override and #override > 0 then
    local out = {}
    for _, d in ipairs(override) do
      if DIRECTION_VALUES[d] then out[#out+1] = d end
    end
    if #out > 0 then return out end
  end
  return DIRECTION_NAMES
end

local function classify_blockers(blockers)
  local clearable, hard = {}, {}
  for _, b in ipairs(blockers) do
    if CLEARABLE_TYPES[b.type] then
      clearable[#clearable+1] = b
    else
      hard[#hard+1] = b
    end
  end
  return clearable, hard
end

local function find_blockers(surface, pos)
  local out = {}
  local found = surface.find_entities_filtered{ position = pos, radius = 2 }
  for _, b in ipairs(found) do
    if b.valid and b.name ~= "character" then
      out[#out+1] = {
        name = b.name,
        type = b.type,
        position = { x = b.position.x, y = b.position.y },
      }
    end
  end
  return out
end

local function is_perimeter(x, y, minx, maxx, miny, maxy)
  return x == minx or x == maxx or y == miny or y == maxy
end

-- Group raw (pos × direction) results by position; collapse the four
-- directions into a single candidate.directions array.
local function direction_merge(rows)
  local groups = {}
  local order = {}
  for _, r in ipairs(rows) do
    local k = r.position.x .. "," .. r.position.y
    local g = groups[k]
    if not g then
      g = {
        position = r.position,
        directions = {},
        status = r.status,
        needs_clearing = r.needs_clearing,
      }
      groups[k] = g
      order[#order+1] = k
    end
    g.directions[#g.directions+1] = r.direction
    -- "free" wins over "needs_clearing" if a free direction exists.
    if r.status == "free" then
      g.status = "free"
      g.needs_clearing = nil
    end
  end
  local merged = {}
  for _, k in ipairs(order) do merged[#merged+1] = groups[k] end
  return merged
end

local function sort_candidates(merged, sort_by, region)
  if sort_by == "centroid_distance" then
    local cx = (region.left_top.x + region.right_bottom.x) / 2
    local cy = (region.left_top.y + region.right_bottom.y) / 2
    table.sort(merged, function(a, b)
      local da = (a.position.x - cx)^2 + (a.position.y - cy)^2
      local db = (b.position.x - cx)^2 + (b.position.y - cy)^2
      return da < db
    end)
  else  -- "raster"
    table.sort(merged, function(a, b)
      if a.position.y ~= b.position.y then return a.position.y < b.position.y end
      return a.position.x < b.position.x
    end)
  end
end

return {
  query = function(params)
    params = params or {}
    local entity = params.entity
    if not entity then
      rcon.print(helpers.table_to_json{ok=false, error="entity is required"})
      return
    end
    if not prototypes.entity[entity] then
      rcon.print(helpers.table_to_json{ok=false, error="unknown entity prototype: "..entity})
      return
    end

    local force_name   = params.force   or "player"
    local surface_name = params.surface or "nauvis"
    local surface = game.surfaces[surface_name]
    if not surface then
      rcon.print(helpers.table_to_json{ok=false, error="surface not found: "..surface_name})
      return
    end

    -- Region normalization.
    local region = params.region
    if not region then
      rcon.print(helpers.table_to_json{ok=false, error="region is required"})
      return
    end
    if region.center and region.radius then
      local r = region.radius
      region = {
        left_top     = { x = region.center.x - r, y = region.center.y - r },
        right_bottom = { x = region.center.x + r, y = region.center.y + r },
      }
    end
    if not (region.left_top and region.right_bottom) then
      rcon.print(helpers.table_to_json{ok=false, error="region needs {left_top,right_bottom} or {center,radius}"})
      return
    end

    local mode           = params.mode or "raw"
    local max_results    = math.min(math.max(params.max_results or 32, 1), 256)
    local sort_by        = params.sort_by or "centroid_distance"
    local include_blocked = params.include_blocked_by_clearable == true
    local dir_list       = applicable_directions(params.directions)

    local minx = math.floor(region.left_top.x)
    local maxx = math.floor(region.right_bottom.x)
    local miny = math.floor(region.left_top.y)
    local maxy = math.floor(region.right_bottom.y)

    -- Estimate cost so a misuse (huge bbox in raw mode) trips the cap
    -- before chewing CPU.
    local tile_area = (maxx - minx + 1) * (maxy - miny + 1)
    local probe_estimate
    if mode == "edge" then
      probe_estimate = (2 * (maxx - minx + 1) + 2 * (maxy - miny + 1)) * #dir_list
    else
      probe_estimate = tile_area * #dir_list
    end
    if probe_estimate > SCAN_HARD_CAP then
      rcon.print(helpers.table_to_json{
        ok = false,
        error = string.format("scan would exceed hard cap (%d > %d); shrink region or use mode=edge",
                              probe_estimate, SCAN_HARD_CAP),
      })
      return
    end

    local rows = {}
    local scanned = 0
    for y = miny, maxy do
      for x = minx, maxx do
        local on_perim = is_perimeter(x, y, minx, maxx, miny, maxy)
        if mode ~= "edge" or on_perim then
          scanned = scanned + 1
          for _, dir_name in ipairs(dir_list) do
            local pos = { x = x, y = y }
            local can = surface.can_place_entity{
              name      = entity,
              position  = pos,
              direction = DIRECTION_VALUES[dir_name],
              force     = force_name,
            }
            if can then
              rows[#rows+1] = { position = pos, direction = dir_name, status = "free" }
            elseif include_blocked then
              local blockers = find_blockers(surface, pos)
              if #blockers > 0 then
                local clearable, hard = classify_blockers(blockers)
                if #hard == 0 and #clearable > 0 then
                  rows[#rows+1] = {
                    position = pos,
                    direction = dir_name,
                    status = "needs_clearing",
                    needs_clearing = clearable,
                  }
                end
              end
            end
          end
        end
      end
    end

    local merged = direction_merge(rows)
    local total_found = #merged
    sort_candidates(merged, sort_by, region)

    local truncated = {}
    for i = 1, math.min(#merged, max_results) do truncated[i] = merged[i] end

    rcon.print(helpers.table_to_json{
      ok = true,
      entity = entity,
      mode = mode,
      candidates = truncated,
      total_found = total_found,
      returned = #truncated,
      scanned_tiles = scanned,
    })
  end
}

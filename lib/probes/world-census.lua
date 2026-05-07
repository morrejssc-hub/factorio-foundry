-- world-census.lua — deterministic all-in-one probe for the Probe phase.
-- Returns everything needed for state.yaml in a single rcon call.
--
-- params:
--   radius      scan radius from worker position in tiles (default 150)
--   cluster_gap max tile-to-tile gap still counted as one patch (default 3)
--   center_x/y  fallback scan center when no worker found (default 0,0)
--
-- Response (JSON, single line):
--   { ok, tick, worker_found, position:{x,y}, inventory:[{item,count}],
--     coal_patches, iron_patches, copper_patches, stone_patches }
-- Each patch: { center:{x,y}, tile_count:<int>, total_amount:<int> }
-- Empty arrays serialize as [] (not null or {}).

return {
  query = function(params)
    local radius      = (params and params.radius)      or 150
    local cluster_gap = (params and params.cluster_gap) or 3
    local surface     = game.surfaces[1]

    -- Locate the tagged worker character.
    local worker = nil
    for _, char in pairs(surface.find_entities_filtered{name = "character"}) do
      if char.valid and char.name_tag == "factorio-agent-worker" then
        worker = char
        break
      end
    end

    local cx = (worker and worker.position.x) or (params and params.center_x) or 0
    local cy = (worker and worker.position.y) or (params and params.center_y) or 0

    -- Collect worker inventory (sorted by item name for stable output).
    local inventory = {}
    if worker then
      local inv = worker.get_inventory(defines.inventory.character_main)
      if inv then
        for _, stack in ipairs(inv.get_contents()) do
          inventory[#inventory + 1] = {item = stack.name, count = stack.count}
        end
        table.sort(inventory, function(a, b) return a.item < b.item end)
      end
    end

    -- find_patches(resource_name) → array of patch summaries.
    -- Uses integer-grid BFS with a hash map for O(n) connected-component
    -- clustering. Tiles at fractional positions are snapped to nearest int.
    local function find_patches(resource_name)
      local area = {{cx - radius, cy - radius}, {cx + radius, cy + radius}}
      local entities = surface.find_entities_filtered{
        type = "resource", area = area, name = resource_name
      }
      if #entities == 0 then return {} end

      -- Build amount lookup keyed by snapped integer position "x,y".
      local amount_map = {}
      local snapped    = {}
      for i = 1, #entities do
        local e  = entities[i]
        local ix = math.floor(e.position.x + 0.5)
        local iy = math.floor(e.position.y + 0.5)
        local k  = ix .. "," .. iy
        amount_map[k] = (e.amount or 0)
        snapped[i]    = {ix, iy}
      end

      -- BFS to find connected components.
      local visited = {}
      local patches  = {}

      for i = 1, #snapped do
        local sx, sy    = snapped[i][1], snapped[i][2]
        local start_key = sx .. "," .. sy
        if not visited[start_key] then
          local comp   = {}
          local queue  = {snapped[i]}
          local qhead  = 1
          visited[start_key] = true

          while qhead <= #queue do
            local pos = queue[qhead]; qhead = qhead + 1
            comp[#comp + 1] = pos
            for dx = -cluster_gap, cluster_gap do
              for dy = -cluster_gap, cluster_gap do
                local nx = pos[1] + dx
                local ny = pos[2] + dy
                local nk = nx .. "," .. ny
                if amount_map[nk] and not visited[nk] then
                  visited[nk] = true
                  queue[#queue + 1] = {nx, ny}
                end
              end
            end
          end

          -- Compute centroid and totals for this patch.
          local sum_x, sum_y, total = 0, 0, 0
          for _, t in ipairs(comp) do
            sum_x = sum_x + t[1]
            sum_y = sum_y + t[2]
            total = total + (amount_map[t[1] .. "," .. t[2]] or 0)
          end
          local n = #comp
          patches[#patches + 1] = {
            center       = {x = math.floor(sum_x / n + 0.5),
                            y = math.floor(sum_y / n + 0.5)},
            tile_count   = n,
            total_amount = math.floor(total)
          }
        end
      end

      return patches
    end

    local coal_patches   = find_patches("coal")
    local iron_patches   = find_patches("iron-ore")
    local copper_patches = find_patches("copper-ore")
    local stone_patches  = find_patches("stone")

    -- helpers.table_to_json treats empty tables as {} (object), not [].
    -- Wrap so callers always get a JSON array.
    local function arr(t)
      if #t == 0 then return "[]" end
      return helpers.table_to_json(t)
    end

    rcon.print(string.format(
      '{"ok":true,"tick":%d,"worker_found":%s,' ..
      '"position":{"x":%g,"y":%g},' ..
      '"inventory":%s,' ..
      '"coal_patches":%s,"iron_patches":%s,' ..
      '"copper_patches":%s,"stone_patches":%s}',
      game.tick,
      (worker ~= nil) and "true" or "false",
      cx, cy,
      arr(inventory),
      arr(coal_patches),
      arr(iron_patches),
      arr(copper_patches),
      arr(stone_patches)
    ))
  end
}

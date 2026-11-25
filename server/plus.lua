-- whip_banking 2.1 features: savings vaults, standing orders, pay requests and bill splits, spending insights and
-- card controls. One API (BankingPlus.api) answers both the branch screen (server/main.lua, the 'plus' callback) and
-- the phone's Bank app (whip_phone/server/bank.lua, through the `Phone` export below).
--
-- MONEY ONLY MOVES THROUGH WHIP'S BANK. A vault is a real savings account (CreateBankAccount); its goal, lock and
-- interest clock are the only things kept here. Every move is BankTransfer as the player (their permissions are the
-- bank's), interest is BankSystemDeposit. Nothing here holds a balance of its own.
--
-- CLAIM, THEN MOVE. A standing order or a request is claimed with a conditional UPDATE before its money moves, so
-- two ticks, two phones or two servers can never pay it twice. A crash between the claim and the move skips one
-- run rather than paying it twice.

BankingPlus = {}
local core = exports.whip_core
local ready = false
local busy = {}             -- [charId] = true while one of their writes runs
local againAt = {}          -- ['from:to'] = os.time() of the last declined request between them

local V, S, R = Config.Vaults, Config.Schedules, Config.Requests

-- ---------------------------------------------------------------- storage
local TABLES = {
    { 'whip_banking_vaults', [[
        CREATE TABLE IF NOT EXISTS whip_banking_vaults (
            accountId INT UNSIGNED NOT NULL PRIMARY KEY,
            charId INT UNSIGNED NOT NULL,
            goal BIGINT UNSIGNED NOT NULL DEFAULT 0,
            lockedUntil BIGINT NOT NULL DEFAULT 0,
            colour VARCHAR(16) NOT NULL DEFAULT 'blue',
            lastInterestAt BIGINT NOT NULL DEFAULT 0,
            interestEarned BIGINT UNSIGNED NOT NULL DEFAULT 0,
            goalReached TINYINT NOT NULL DEFAULT 0,
            createdAt BIGINT NOT NULL DEFAULT 0,
            INDEX vault_owner (charId)
        )
    ]] },
    { 'whip_banking_schedules', [[
        CREATE TABLE IF NOT EXISTS whip_banking_schedules (
            id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            charId INT UNSIGNED NOT NULL,
            fromAccountId INT UNSIGNED NOT NULL,
            toAccountId INT UNSIGNED NOT NULL,
            toLabel VARCHAR(60) NOT NULL DEFAULT '',
            amount INT UNSIGNED NOT NULL,
            label VARCHAR(60) NOT NULL DEFAULT '',
            everyHours INT UNSIGNED NOT NULL,
            nextRunAt BIGINT NOT NULL,
            runsLeft INT NULL,
            failures INT NOT NULL DEFAULT 0,
            status VARCHAR(10) NOT NULL DEFAULT 'active',
            lastError VARCHAR(120) NULL,
            lastRunAt BIGINT NOT NULL DEFAULT 0,
            createdAt BIGINT NOT NULL DEFAULT 0,
            INDEX due (status, nextRunAt),
            INDEX schedule_owner (charId)
        )
    ]] },
    { 'whip_banking_requests', [[
        CREATE TABLE IF NOT EXISTS whip_banking_requests (
            id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            groupId VARCHAR(36) NULL,
            fromCharId INT UNSIGNED NOT NULL,
            fromName VARCHAR(60) NOT NULL DEFAULT '',
            toCharId INT UNSIGNED NOT NULL,
            toName VARCHAR(60) NULL,
            toAccountId INT UNSIGNED NOT NULL,
            amount INT UNSIGNED NOT NULL,
            note VARCHAR(100) NOT NULL DEFAULT '',
            status VARCHAR(10) NOT NULL DEFAULT 'pending',
            createdAt BIGINT NOT NULL,
            expiresAt BIGINT NOT NULL,
            settledAt BIGINT NOT NULL DEFAULT 0,
            INDEX payer (toCharId, status),
            INDEX requester (fromCharId, status)
        )
    ]] },
}

Whip.register(function()
    CreateThread(function()
        for _, t in ipairs(TABLES) do
            local ok, why = Whip.core:EnsureTable(t[1], t[2])
            if not ok then
                print(('[whip_banking] %s unavailable: %s'):format(t[1], tostring(why)))
                ready = false
                return
            end
        end
        ready = true
    end)
end)

-- ---------------------------------------------------------------- helpers
local function whole(v, min, max)
    local n = math.tointeger(tonumber(v))
    if not n or n < (min or 1) or (max and n > max) then return nil end
    return n
end

--- A line of text: control characters out, trimmed, at most `max` bytes (never half a character).
local function text(v, max)
    if type(v) ~= 'string' then return '' end
    v = v:gsub('[%z\1-\31]', ''):match('^%s*(.-)%s*$')
    if #v > max then v = v:sub(1, max):gsub('[\192-\255][\128-\191]*$', '') end
    return v
end

local function money(n)
    local s = tostring(math.floor(math.abs(tonumber(n) or 0)))
    return '$' .. s:reverse():gsub('(%d%d%d)', '%1,'):reverse():gsub('^,', '')
end

local function frozen(acc) return acc and (acc.frozen == true or acc.frozen == 1) end

--- The online source of a character, or nil.
local function sourceOf(charId)
    local players = core:GetPlayers({ light = true })
    for src, p in pairs(type(players) == 'table' and players or {}) do
        if p.charId == charId then return tonumber(src) end
    end
end

--- Tell a character something: on their phone's Bank app when they carry one, else a toast. Offline: nothing.
local function tell(charId, title, message, kind, args)
    local src = sourceOf(charId)
    if not src then return end
    if GetResourceState('whip_phone') == 'started' then
        local ok = pcall(function()
            exports.whip_phone:Notify(src, { app = 'bank', title = title, text = message, kind = kind or 'info', args = args })
            exports.whip_phone:Push(src, 'bank', 'plus', { what = args and args.what or 'any' })
        end)
        if ok then return end
    end
    core:NotifyPlayer(src, title .. ': ' .. message, kind == 'error' and 'error' or kind == 'success' and 'success' or 'info')
end

--- One of this character's accounts with their role on it, or false, why.
local function own(charId, accountId, role)
    accountId = whole(accountId)
    if not accountId then return false, 'Pick an account.' end
    local acc = core:GetBankAccount(accountId)
    if not acc or acc.closedAt then return false, 'This account is unavailable.' end
    local ok, why = core:CanUseBankAccount(accountId, { charId = charId }, role or 'view')
    if not ok then return false, why or 'You cannot use this account.' end
    return acc
end

--- An account by its number (WB-123456), for paying someone else. Not frozen.
local function byNumber(number)
    local n = text(tostring(number or ''), 12):upper():gsub('%s', '')
    if n:match('^%d%d%d%d%d%d$') then n = 'WB-' .. n end
    if not n:match('^WB%-%d%d%d%d%d%d$') then return false, 'An account number looks like WB-123456.' end
    local acc = core:GetBankAccount({ number = n })
    if not acc or acc.closedAt or frozen(acc) then return false, 'That account is unavailable.' end
    return acc
end

--- A vault's lock, or nil: money may not leave a locked vault through banking or the phone.
function BankingPlus.lockedWhy(accountId)
    if not ready then return nil end
    local until_ = MySQL.scalar.await('SELECT lockedUntil FROM whip_banking_vaults WHERE accountId = ?', { accountId })
    until_ = tonumber(until_) or 0
    if until_ > os.time() then
        return ('This vault is locked until %s.'):format(os.date('!%d %b %Y %H:%M UTC', until_))
    end
end

--- One write per character at a time.
local function exclusive(charId, fn)
    if busy[charId] then return false, 'Another banking request is still in progress.' end
    busy[charId] = true
    local ran, a, b = pcall(fn)
    busy[charId] = nil
    if not ran then
        print(('[whip_banking] plus request failed for character %d: %s'):format(charId, tostring(a)))
        return false, 'The request was interrupted. Check your accounts before trying again.'
    end
    return a, b
end

-- ---------------------------------------------------------------- vaults
local COLOURS = { blue = true, green = true, gold = true, rose = true, violet = true, teal = true }

local function vaultView(row, acc, balance)
    local goal = tonumber(row.goal) or 0
    return {
        id = acc.accountId, number = acc.accountNumber, name = acc.label or 'Vault', balance = balance,
        goal = goal, progress = goal > 0 and math.min(1, balance / goal) or nil,
        lockedUntil = tonumber(row.lockedUntil) > os.time() and tonumber(row.lockedUntil) or 0,
        colour = COLOURS[row.colour] and row.colour or 'blue',
        interestEarned = tonumber(row.interestEarned) or 0,
        nextInterestAt = (tonumber(row.lastInterestAt) or 0) + V.InterestEveryHours * 3600,
        rate = V.InterestBasisPoints / 100,
    }
end

local function vaults(charId)
    local rows = MySQL.query.await('SELECT * FROM whip_banking_vaults WHERE charId = ? ORDER BY createdAt', { charId }) or {}
    local out = {}
    for _, row in ipairs(rows) do
        local acc = core:GetBankAccount(row.accountId)
        if acc and not acc.closedAt and core:CanUseBankAccount(row.accountId, { charId = charId }, 'owner') then
            local balance = core:GetBalance({ accountId = row.accountId })
            out[#out + 1] = vaultView(row, acc, tonumber(balance) or 0)
        elseif not acc or acc.closedAt then
            MySQL.update.await('DELETE FROM whip_banking_vaults WHERE accountId = ?', { row.accountId })
        end
    end
    return out
end

local function vaultRow(charId, id)
    id = whole(id)
    if not id then return false, 'Pick a vault.' end
    local row = MySQL.single.await('SELECT * FROM whip_banking_vaults WHERE accountId = ? AND charId = ?', { id, charId })
    if not row then return false, 'This vault is unavailable.' end
    return row
end

local function checkGoal(charId, accountId)
    local row = MySQL.single.await('SELECT goal, goalReached FROM whip_banking_vaults WHERE accountId = ?', { accountId })
    if not row or tonumber(row.goal) <= 0 or tonumber(row.goalReached) == 1 then return end
    local balance = tonumber(core:GetBalance({ accountId = accountId })) or 0
    if balance >= tonumber(row.goal) then
        if MySQL.update.await('UPDATE whip_banking_vaults SET goalReached = 1 WHERE accountId = ? AND goalReached = 0', { accountId }) == 1 then
            local acc = core:GetBankAccount(accountId)
            tell(charId, (acc and acc.label) or 'Vault', ('Goal reached: %s saved'):format(money(row.goal)), 'success', { what = 'vaults', vault = accountId })
        end
    end
end

-- ---------------------------------------------------------------- standing orders
local function intervalOk(h)
    for _, v in ipairs(S.Intervals) do if v == h then return true end end
    return false
end

local function scheduleView(r)
    return {
        id = r.id, fromAccountId = r.fromAccountId, toLabel = r.toLabel, amount = tonumber(r.amount),
        label = r.label, everyHours = tonumber(r.everyHours), nextRunAt = tonumber(r.nextRunAt),
        runsLeft = r.runsLeft and tonumber(r.runsLeft) or nil, status = r.status,
        lastError = r.lastError, lastRunAt = tonumber(r.lastRunAt), failures = tonumber(r.failures),
    }
end

local function schedules(charId)
    local rows = MySQL.query.await([[
        SELECT * FROM whip_banking_schedules WHERE charId = ? AND status IN ('active', 'paused') ORDER BY nextRunAt
    ]], { charId }) or {}
    local out = {}
    for i, r in ipairs(rows) do out[i] = scheduleView(r) end
    return out
end

local function runSchedule(r)
    local every = tonumber(r.everyHours) * 3600
    local now = os.time()
    local nextAt = tonumber(r.nextRunAt) + every
    if nextAt <= now then nextAt = now + every end
    local claimed = MySQL.update.await([[
        UPDATE whip_banking_schedules SET nextRunAt = ?, lastRunAt = ?
        WHERE id = ? AND nextRunAt = ? AND status = 'active'
    ]], { nextAt, now, r.id, r.nextRunAt })
    if claimed ~= 1 then return end

    local ok, why
    local locked = BankingPlus.lockedWhy(r.fromAccountId)
    if locked then ok, why = false, locked
    else
        ok, why = core:BankTransfer(r.fromAccountId, r.toAccountId, tonumber(r.amount), { charId = r.charId },
            { reason = 'Standing order · ' .. (r.label ~= '' and r.label or r.toLabel) })
    end
    if ok then
        local left = r.runsLeft and tonumber(r.runsLeft) - 1 or nil
        MySQL.update.await([[
            UPDATE whip_banking_schedules SET failures = 0, lastError = NULL, runsLeft = ?,
                status = IF(? IS NOT NULL AND ? <= 0, 'done', status) WHERE id = ?
        ]], { left, left, left, r.id })
        checkGoal(r.charId, r.toAccountId)
        return
    end
    local failures = (tonumber(r.failures) or 0) + 1
    local pause = failures >= S.MaxFailures
    MySQL.update.await([[
        UPDATE whip_banking_schedules SET failures = ?, lastError = ?, status = IF(?, 'paused', status) WHERE id = ?
    ]], { failures, text(why or 'Refused', 120), pause and 1 or 0, r.id })
    tell(r.charId, 'Standing order', pause
        and ('%s to %s paused after %d failed tries: %s'):format(money(r.amount), r.toLabel, failures, why or 'refused')
        or ('%s to %s did not go: %s'):format(money(r.amount), r.toLabel, why or 'refused'),
        pause and 'error' or 'warning', { what = 'schedules' })
end

CreateThread(function()
    while true do
        Wait(math.max(15, S.TickSeconds) * 1000)
        if ready and Whip.isReady() then
            local ok, err = pcall(function()
                local due = MySQL.query.await([[
                    SELECT * FROM whip_banking_schedules WHERE status = 'active' AND nextRunAt <= ? ORDER BY nextRunAt LIMIT 25
                ]], { os.time() }) or {}
                for _, r in ipairs(due) do runSchedule(r) end
            end)
            if not ok then print('[whip_banking] standing orders: ' .. tostring(err)) end
        end
    end
end)

-- ---------------------------------------------------------------- interest
CreateThread(function()
    while true do
        Wait(5 * 60 * 1000)
        if ready and Whip.isReady() and V.InterestBasisPoints > 0 and V.InterestCap > 0 then
            local ok, err = pcall(function()
                local now = os.time()
                local due = MySQL.query.await('SELECT * FROM whip_banking_vaults WHERE lastInterestAt <= ? LIMIT 200',
                    { now - V.InterestEveryHours * 3600 }) or {}
                for _, row in ipairs(due) do
                    if not V.OnlineOnly or sourceOf(row.charId) then
                        local balance = tonumber(core:GetBalance({ accountId = row.accountId })) or 0
                        local amount = math.min(V.InterestCap, balance * V.InterestBasisPoints // 10000)
                        local claimed = MySQL.update.await([[
                            UPDATE whip_banking_vaults SET lastInterestAt = ? WHERE accountId = ? AND lastInterestAt = ?
                        ]], { now, row.accountId, row.lastInterestAt })
                        if claimed == 1 and balance >= V.MinBalance and amount >= 1 then
                            local paid = core:BankSystemDeposit(row.accountId, amount, { reason = 'Vault interest', actorCharId = row.charId })
                            if paid then
                                MySQL.update.await('UPDATE whip_banking_vaults SET interestEarned = interestEarned + ? WHERE accountId = ?', { amount, row.accountId })
                                checkGoal(row.charId, row.accountId)
                            end
                        end
                    end
                end
            end)
            if not ok then print('[whip_banking] vault interest: ' .. tostring(err)) end
        end
    end
end)

-- ---------------------------------------------------------------- requests
local function requestView(r, mine)
    return {
        id = r.id, group = r.groupId, amount = tonumber(r.amount), note = r.note, status = r.status,
        name = mine and (r.toName or 'Someone') or r.fromName, createdAt = tonumber(r.createdAt),
        expiresAt = tonumber(r.expiresAt), settledAt = tonumber(r.settledAt),
    }
end

local function requests(charId)
    local now = os.time()
    MySQL.update.await([[
        UPDATE whip_banking_requests SET status = 'expired'
        WHERE status = 'pending' AND expiresAt <= ? AND (toCharId = ? OR fromCharId = ?)
    ]], { now, charId, charId })
    local incoming = MySQL.query.await([[
        SELECT * FROM whip_banking_requests WHERE toCharId = ? AND status = 'pending' ORDER BY createdAt DESC LIMIT 50
    ]], { charId }) or {}
    local outgoing = MySQL.query.await([[
        SELECT * FROM whip_banking_requests WHERE fromCharId = ? AND (status = 'pending' OR settledAt > ?)
        ORDER BY createdAt DESC LIMIT 50
    ]], { charId, now - 7 * 86400 }) or {}
    local inn, out = {}, {}
    for i, r in ipairs(incoming) do inn[i] = requestView(r, false) end
    for i, r in ipairs(outgoing) do out[i] = requestView(r, true) end
    return { incoming = inn, outgoing = out }
end

-- ---------------------------------------------------------------- insights
local function categoryOf(tx, accountId, vaultIds)
    local outgoing = tonumber(tx.fromAccountId) == accountId
    if not outgoing then return 'income' end
    if tx.type == 'withdraw' then return 'cash' end
    if tx.type == 'transfer' and vaultIds[tonumber(tx.toAccountId)] then return 'savings' end
    local message = type(tx.message) == 'string' and tx.message:lower() or ''
    for _, c in ipairs(Config.Categories) do
        for _, w in ipairs(c.words) do
            if message:find(w, 1, true) then return c.id end
        end
    end
    return tx.type == 'payment' and 'shopping' or 'other'
end

local LABELS = { income = 'Income', cash = 'Cash withdrawals', other = 'Other' }
for _, c in ipairs(Config.Categories) do LABELS[c.id] = c.label end

local function insights(charId, accountId)
    local acc, why = own(charId, accountId, 'view')
    if not acc then return false, why end
    local rows = core:GetBankTransactions(acc.accountId, 200, 0)
    if type(rows) ~= 'table' then return false, 'The statement is unavailable.' end
    local vaultIds = {}
    for _, v in ipairs(MySQL.query.await('SELECT accountId FROM whip_banking_vaults WHERE charId = ?', { charId }) or {}) do
        vaultIds[tonumber(v.accountId)] = true
    end
    local now = os.time()
    local day0 = now // 86400
    local monthIn, monthOut, prevOut = 0, 0, 0
    local byCat, days, biggest = {}, {}, nil
    for d = 13, 0, -1 do days[#days + 1] = { day = (day0 - d) * 86400, ['in'] = 0, out = 0 } end
    for _, tx in ipairs(rows) do
        local at = tonumber(tx.createdAt) or 0
        local amount = tonumber(tx.amount) or 0
        local outgoing = tonumber(tx.fromAccountId) == acc.accountId and tonumber(tx.toAccountId) ~= acc.accountId
        local age = now - at
        if age <= 30 * 86400 then
            if outgoing then
                monthOut = monthOut + amount
                local c = categoryOf(tx, acc.accountId, vaultIds)
                byCat[c] = (byCat[c] or 0) + amount
                if not biggest or amount > biggest.amount then
                    biggest = { amount = amount, text = tx.message ~= '' and tx.message or LABELS[c], at = at }
                end
            else
                monthIn = monthIn + amount
            end
        elseif age <= 60 * 86400 and outgoing then
            prevOut = prevOut + amount
        end
        local slot = days[14 - (day0 - at // 86400)]
        if slot then
            if outgoing then slot.out = slot.out + amount else slot['in'] = slot['in'] + amount end
        end
    end
    local cats = {}
    for id, total in pairs(byCat) do
        cats[#cats + 1] = { id = id, label = LABELS[id] or id, total = total, share = monthOut > 0 and total / monthOut or 0 }
    end
    table.sort(cats, function(a, b) return a.total > b.total end)
    return {
        accountId = acc.accountId, monthIn = monthIn, monthOut = monthOut, previousOut = prevOut,
        net = monthIn - monthOut, categories = cats, days = days, biggest = biggest,
        averageDaily = monthOut // 30, sampled = #rows,
    }
end

-- ---------------------------------------------------------------- the API
-- Every entry: fn(source, player, args) -> result | false, why. `player` is a WHIP sheet (charId, fullName, session).
local api = {}
BankingPlus.api = api

function api.overview(source, player)
    if not ready then return false, 'Banking features are starting. Try again in a moment.' end
    local reqs = requests(player.charId)
    return {
        vaults = vaults(player.charId), schedules = schedules(player.charId), requests = reqs,
        intervals = S.Intervals, limits = { vaults = V.Max, schedules = S.Max, split = R.MaxSplit,
            lockDays = V.MaxLockDays, cardLimit = Config.Cards.MaxDailyLimit, transaction = Config.MaxTransaction },
        cards = BankingCards.list(source, player.charId),
        bank = { name = Config.BankName, tagline = Config.BankTagline, colour = Config.BankColour },
    }
end

-- args = { name, goal?, colour?, lockDays? }
function api.vaultCreate(source, player, args)
    if not ready then return false, 'Vaults are unavailable.' end
    local name = text(args.name, 40)
    if name == '' then return false, 'Give the vault a name.' end
    local goal = whole(args.goal, 0, 1000000000) or 0
    local lockDays = whole(args.lockDays, 0, V.MaxLockDays) or 0
    local colour = COLOURS[args.colour] and args.colour or 'blue'
    return exclusive(player.charId, function()
        local count = MySQL.scalar.await('SELECT COUNT(*) FROM whip_banking_vaults WHERE charId = ?', { player.charId })
        if (tonumber(count) or 0) >= V.Max then return false, ('You can have %d vaults.'):format(V.Max) end
        local acc, why = core:CreateBankAccount({ charId = player.charId }, name, { type = 'savings' })
        if not acc then return false, why or 'The bank could not open the vault.' end
        local now = os.time()
        local ok = MySQL.insert.await([[
            INSERT INTO whip_banking_vaults (accountId, charId, goal, lockedUntil, colour, lastInterestAt, createdAt)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        ]], { acc.accountId, player.charId, goal, lockDays > 0 and now + lockDays * 86400 or 0, colour, now, now })
        if ok == nil then
            core:CloseBankAccount(acc.accountId, { charId = player.charId })
            return false, 'The vault could not be set up.'
        end
        return { id = acc.accountId, number = acc.accountNumber }
    end)
end

-- args = { id, goal?, colour?, lockDays? (extends only: a lock can never be shortened) }
function api.vaultEdit(_, player, args)
    local row, why = vaultRow(player.charId, args.id)
    if not row then return false, why end
    local goal = args.goal ~= nil and whole(args.goal, 0, 1000000000) or tonumber(row.goal)
    if not goal then return false, 'Enter a goal in whole dollars.' end
    local colour = COLOURS[args.colour] and args.colour or row.colour
    local lockedUntil = tonumber(row.lockedUntil)
    if args.lockDays ~= nil then
        local days = whole(args.lockDays, 0, V.MaxLockDays)
        if not days then return false, ('Lock for 0 to %d days.'):format(V.MaxLockDays) end
        lockedUntil = math.max(lockedUntil, days > 0 and os.time() + days * 86400 or 0)
    end
    MySQL.update.await([[
        UPDATE whip_banking_vaults SET goal = ?, colour = ?, lockedUntil = ?, goalReached = IF(? = goal, goalReached, 0)
        WHERE accountId = ?
    ]], { goal, colour, lockedUntil, goal, row.accountId })
    checkGoal(player.charId, row.accountId)
    return true
end

-- args = { id = vault, account = your other account, amount, direction = 'in'|'out' }
function api.vaultMove(_, player, args)
    local row, why = vaultRow(player.charId, args.id)
    if not row then return false, why end
    local amount = whole(args.amount, 1, Config.MaxTransaction)
    if not amount then return false, ('Enter $1 to %s.'):format(money(Config.MaxTransaction)) end
    local into = args.direction ~= 'out'
    local other, otherWhy = own(player.charId, args.account, into and 'withdraw' or 'deposit')
    if not other then return false, otherWhy end
    if other.accountId == row.accountId then return false, 'Pick a different account.' end
    if frozen(other) then return false, 'That account is frozen.' end
    return exclusive(player.charId, function()
        if not into then
            local locked = BankingPlus.lockedWhy(row.accountId)
            if locked then return false, locked end
        end
        local from, to = into and other.accountId or row.accountId, into and row.accountId or other.accountId
        local ok, err = core:BankTransfer(from, to, amount, { charId = player.charId },
            { reason = into and 'To vault' or 'From vault' })
        if not ok then return false, err end
        if into then checkGoal(player.charId, row.accountId) end
        return true
    end)
end

-- args = { id, account } : everything left goes to `account`, then the vault closes.
function api.vaultClose(_, player, args)
    local row, why = vaultRow(player.charId, args.id)
    if not row then return false, why end
    local locked = BankingPlus.lockedWhy(row.accountId)
    if locked then return false, locked end
    return exclusive(player.charId, function()
        local balance = tonumber(core:GetBalance({ accountId = row.accountId })) or 0
        if balance > 0 then
            local other, otherWhy = own(player.charId, args.account, 'deposit')
            if not other or other.accountId == row.accountId then return false, otherWhy or 'Pick where the money goes.' end
            local ok, err = core:BankTransfer(row.accountId, other.accountId, balance, { charId = player.charId }, { reason = 'Vault closed' })
            if not ok then return false, err end
        end
        local closed, err = core:CloseBankAccount(row.accountId, { charId = player.charId })
        if not closed then return false, err end
        MySQL.update.await('DELETE FROM whip_banking_vaults WHERE accountId = ?', { row.accountId })
        return true
    end)
end

-- args = { from, to? (yours) | number? (anyone's), amount, label, everyHours, runs? (nil: until stopped), startIn? hours }
function api.scheduleCreate(_, player, args)
    if not ready then return false, 'Standing orders are unavailable.' end
    local amount = whole(args.amount, 1, Config.MaxTransaction)
    if not amount then return false, ('Enter $1 to %s.'):format(money(Config.MaxTransaction)) end
    local every = whole(args.everyHours)
    if not every or not intervalOk(every) then return false, 'Pick how often it pays.' end
    local runs = args.runs ~= nil and whole(args.runs, 1, 1000) or nil
    if args.runs ~= nil and not runs then return false, 'Pay 1 to 1,000 times, or until you stop it.' end
    local from, fromWhy = own(player.charId, args.from, 'withdraw')
    if not from then return false, fromWhy end
    local to, toLabel
    if args.number ~= nil and args.number ~= '' then
        local acc, accWhy = byNumber(args.number)
        if not acc then return false, accWhy end
        to, toLabel = acc, acc.accountNumber
    else
        local acc, accWhy = own(player.charId, args.to, 'deposit')
        if not acc then return false, accWhy end
        to, toLabel = acc, acc.label or acc.accountNumber
    end
    if to.accountId == from.accountId then return false, 'That is the same account.' end
    local label = text(args.label, 60)
    local startIn = whole(args.startIn, 0, 168) or 0
    local count = MySQL.scalar.await([[
        SELECT COUNT(*) FROM whip_banking_schedules WHERE charId = ? AND status IN ('active', 'paused')
    ]], { player.charId })
    if (tonumber(count) or 0) >= S.Max then return false, ('You can have %d standing orders.'):format(S.Max) end
    local now = os.time()
    local id = MySQL.insert.await([[
        INSERT INTO whip_banking_schedules (charId, fromAccountId, toAccountId, toLabel, amount, label, everyHours, nextRunAt, runsLeft, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ]], { player.charId, from.accountId, to.accountId, text(toLabel, 60), amount, label, every, now + startIn * 3600, runs, now })
    if not id then return false, 'The standing order could not be saved.' end
    return { id = id }
end

-- args = { id, action = 'pause'|'resume'|'cancel'|'run' }
function api.scheduleControl(_, player, args)
    local id = whole(args.id)
    local status = ({ pause = 'paused', resume = 'active', cancel = 'cancelled' })[args.action]
    if not id or not (status or args.action == 'run') then return false, 'Choose pause, resume, run now or cancel.' end
    if args.action == 'run' then
        local r = MySQL.single.await([[
            SELECT * FROM whip_banking_schedules WHERE id = ? AND charId = ? AND status = 'active'
        ]], { id, player.charId })
        if not r then return false, 'This standing order is unavailable.' end
        -- Pays the next one now; the one after follows on its usual interval.
        return exclusive(player.charId, function() runSchedule(r) return true end)
    end
    local affected = MySQL.update.await([[
        UPDATE whip_banking_schedules SET status = ?, failures = IF(? = 'active', 0, failures),
            nextRunAt = IF(? = 'active' AND nextRunAt < UNIX_TIMESTAMP(), UNIX_TIMESTAMP(), nextRunAt)
        WHERE id = ? AND charId = ? AND status IN ('active', 'paused')
    ]], { status, status, status, id, player.charId })
    if affected ~= 1 then return false, 'This standing order is unavailable.' end
    return true
end

--- args = { account = yours, to receive; amount (each, or the total when split); note; split = bool;
---          includeSelf = bool; targets = { { charId, name? }, ... } }  -- targets resolved by the caller's resource
function api.requestCreate(_, player, args)
    if not ready then return false, 'Requests are unavailable.' end
    local into, why = own(player.charId, args.account, 'deposit')
    if not into then return false, why end
    if frozen(into) then return false, 'That account is frozen.' end
    local targets = type(args.targets) == 'table' and args.targets or {}
    local people, seen = {}, {}
    for _, t in ipairs(targets) do
        local charId = type(t) == 'table' and whole(t.charId)
        if charId and charId ~= player.charId and not seen[charId] then
            seen[charId] = true
            people[#people + 1] = { charId = charId, name = type(t.name) == 'string' and text(t.name, 60) or nil }
        end
    end
    if #people == 0 then return false, 'Pick who pays.' end
    if #people > R.MaxSplit then return false, ('Split between up to %d people.'):format(R.MaxSplit) end
    local amount = whole(args.amount, 1, Config.MaxTransaction)
    if not amount then return false, ('Enter $1 to %s.'):format(money(Config.MaxTransaction)) end
    local each = amount
    if args.split == true then
        local shares = #people + (args.includeSelf == false and 0 or 1)
        each = -(-amount // shares)    -- round up: the requester never ends up short
    end
    local note = text(args.note, 100)
    return exclusive(player.charId, function()
        local open = tonumber(MySQL.scalar.await([[
            SELECT COUNT(*) FROM whip_banking_requests WHERE fromCharId = ? AND status = 'pending' AND expiresAt > ?
        ]], { player.charId, os.time() })) or 0
        if open + #people > R.MaxPendingOut then return false, ('You can have %d open requests.'):format(R.MaxPendingOut) end
        for _, p in ipairs(people) do
            local t = againAt[player.charId .. ':' .. p.charId]
            if t and os.time() - t < R.AgainSeconds then return false, 'Wait a few seconds before asking them again.' end
        end
        local now = os.time()
        local group = args.split == true and ('%d-%d'):format(player.charId, GetGameTimer()) or nil
        local sent = 0
        for _, p in ipairs(people) do
            local id = MySQL.insert.await([[
                INSERT INTO whip_banking_requests (groupId, fromCharId, fromName, toCharId, toName, toAccountId, amount, note, createdAt, expiresAt)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ]], { group, player.charId, text(player.fullName or 'Someone', 60), p.charId, p.name, into.accountId, each, note, now, now + R.ExpireHours * 3600 })
            if id then
                sent = sent + 1
                tell(p.charId, player.fullName or 'Payment request',
                    ('asks you for %s%s'):format(money(each), note ~= '' and (' · ' .. note) or ''), 'info', { what = 'requests', request = id })
            end
        end
        if sent == 0 then return false, 'The request could not be sent.' end
        return { sent = sent, each = each }
    end)
end

-- args = { id, account = yours, to pay from }
function api.requestPay(_, player, args)
    local id = whole(args.id)
    if not id then return false, 'This request is gone.' end
    local from, why = own(player.charId, args.account, 'withdraw')
    if not from then return false, why end
    if frozen(from) then return false, 'That account is frozen.' end
    return exclusive(player.charId, function()
        local locked = BankingPlus.lockedWhy(from.accountId)
        if locked then return false, locked end
        local claimed = MySQL.update.await([[
            UPDATE whip_banking_requests SET status = 'paying'
            WHERE id = ? AND toCharId = ? AND status = 'pending' AND expiresAt > ?
        ]], { id, player.charId, os.time() })
        if claimed ~= 1 then return false, 'This request is no longer open.' end
        local r = MySQL.single.await('SELECT * FROM whip_banking_requests WHERE id = ?', { id })
        local ok, err = core:BankTransfer(from.accountId, r.toAccountId, tonumber(r.amount), { charId = player.charId },
            { reason = 'Request · ' .. (r.note ~= '' and r.note or r.fromName) })
        MySQL.update.await('UPDATE whip_banking_requests SET status = ?, settledAt = ? WHERE id = ?',
            { ok and 'paid' or 'pending', ok and os.time() or 0, id })
        if not ok then return false, err end
        tell(r.fromCharId, 'Request paid', ('%s paid %s%s'):format(player.fullName or 'Someone', money(r.amount),
            r.note ~= '' and (' · ' .. r.note) or ''), 'success', { what = 'requests' })
        return true
    end)
end

-- args = { id, action = 'decline' (the payer) | 'cancel' (the requester) | 'remind' (the requester) }
function api.requestAnswer(_, player, args)
    local id = whole(args.id)
    if not id then return false, 'This request is gone.' end
    local r = MySQL.single.await("SELECT * FROM whip_banking_requests WHERE id = ? AND status = 'pending'", { id })
    if not r then return false, 'This request is no longer open.' end
    if args.action == 'decline' and r.toCharId == player.charId then
        MySQL.update.await("UPDATE whip_banking_requests SET status = 'declined', settledAt = ? WHERE id = ? AND status = 'pending'", { os.time(), id })
        againAt[r.fromCharId .. ':' .. r.toCharId] = os.time()
        tell(r.fromCharId, 'Request declined', ('%s for %s was declined'):format(r.note ~= '' and r.note or 'A request', money(r.amount)), 'warning', { what = 'requests' })
        return true
    elseif args.action == 'cancel' and r.fromCharId == player.charId then
        MySQL.update.await("UPDATE whip_banking_requests SET status = 'cancelled', settledAt = ? WHERE id = ? AND status = 'pending'", { os.time(), id })
        return true
    elseif args.action == 'remind' and r.fromCharId == player.charId then
        local key = 'remind:' .. id
        if againAt[key] and os.time() - againAt[key] < 300 then return false, 'You reminded them a moment ago.' end
        againAt[key] = os.time()
        tell(r.toCharId, r.fromName, ('reminds you: %s%s'):format(money(r.amount), r.note ~= '' and (' · ' .. r.note) or ''), 'info', { what = 'requests', request = id })
        return true
    end
    return false, 'You cannot do that with this request.'
end

function api.insights(_, player, args)
    if not ready then return false, 'Insights are unavailable.' end
    return insights(player.charId, args.account)
end

-- args = { account, card, action = 'freeze'|'unfreeze'|'revoke'|'limit'|'rename', value? }
function api.cardControl(_, player, args)
    local acc, why = own(player.charId, args.account, 'view')
    if not acc then return false, why end
    local cardId = type(args.card) == 'string' and args.card:match('^[%x%-]+$') and #args.card <= 36 and args.card
    if not cardId then return false, 'This card is unavailable.' end
    local action = args.action
    if action == 'freeze' or action == 'unfreeze' or action == 'revoke' then
        return BankingCards.manage(player.charId, acc.accountId, cardId,
            ({ freeze = 'block', unfreeze = 'unblock', revoke = 'revoke' })[action])
    elseif action == 'limit' then
        return BankingCards.setLimit(player.charId, acc.accountId, cardId, args.value)
    elseif action == 'rename' then
        return BankingCards.rename(player.charId, acc.accountId, cardId, args.value)
    end
    return false, 'Choose a card control.'
end

--- Run an API action for a player. -> result | false, why. Used by server/main.lua and the Phone export.
function BankingPlus.run(source, player, action, args)
    local fn = type(action) == 'string' and api[action]
    if not fn then return false, 'Unknown banking request.' end
    if not player or not player.charId then return false, 'Your character is not loaded.' end
    local ran, result, why = pcall(fn, source, player, type(args) == 'table' and args or {})
    if not ran then
        print(('[whip_banking] %s failed: %s'):format(action, tostring(result)))
        return false, 'The banking request was interrupted.'
    end
    if result == nil then return false, why or 'The request could not be completed.' end
    return result, why
end

-- ---------------------------------------------------------------- exports
--- For whip_phone's Bank app (it registers its own whip_phone:bank:* callbacks and checks the phone): the player is
--- read here again from their source, never taken from the caller. -> result | false, why
exports('Phone', function(source, action, args)
    local player = core:GetPlayer(source)
    if not player then return false, 'Your character is not loaded.' end
    return BankingPlus.run(source, player, action, args)
end)

--- Is money allowed out of this account? -> true | false, why (a locked vault). Other resources may ask before a
--- transfer of their own.
exports('CanMoveOut', function(accountId)
    local why = BankingPlus.lockedWhy(tonumber(accountId) or 0)
    if why then return false, why end
    return true
end)

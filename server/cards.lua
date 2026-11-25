BankingCards = {}
local core = exports.whip_core
local ready = false
local item = 'whip_debit_card'
local previewPermits = {}

local CREATE = [[
    CREATE TABLE IF NOT EXISTS whip_banking_cards (
        cardId CHAR(36) NOT NULL PRIMARY KEY,
        requestId VARCHAR(64) NOT NULL,
        accountId INT UNSIGNED NOT NULL,
        charId INT UNSIGNED NOT NULL,
        pinSalt CHAR(36) NOT NULL,
        pinHash CHAR(64) NOT NULL,
        status VARCHAR(12) NOT NULL DEFAULT 'pending',
        attempts INT NOT NULL DEFAULT 0,
        lockedUntil BIGINT NOT NULL DEFAULT 0,
        dailyLimit INT UNSIGNED NOT NULL DEFAULT 0,
        spentDay INT UNSIGNED NOT NULL DEFAULT 0,
        spentToday INT UNSIGNED NOT NULL DEFAULT 0,
        nickname VARCHAR(24) NULL,
        lastUsedAt BIGINT NOT NULL DEFAULT 0,
        createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY issue_request (charId, requestId),
        INDEX owner_account (charId, accountId)
    )
]]
-- Card controls (2.1): a daily ATM limit, a nickname, the last use. Added to tables made by 2.0.
local MIGRATIONS = { { id = 'card-controls', statements = {
    { sql = 'ALTER TABLE whip_banking_cards ADD COLUMN dailyLimit INT UNSIGNED NOT NULL DEFAULT 0', unless = { column = { 'whip_banking_cards', 'dailyLimit' } } },
    { sql = 'ALTER TABLE whip_banking_cards ADD COLUMN spentDay INT UNSIGNED NOT NULL DEFAULT 0', unless = { column = { 'whip_banking_cards', 'spentDay' } } },
    { sql = 'ALTER TABLE whip_banking_cards ADD COLUMN spentToday INT UNSIGNED NOT NULL DEFAULT 0', unless = { column = { 'whip_banking_cards', 'spentToday' } } },
    { sql = 'ALTER TABLE whip_banking_cards ADD COLUMN nickname VARCHAR(24) NULL', unless = { column = { 'whip_banking_cards', 'nickname' } } },
    { sql = 'ALTER TABLE whip_banking_cards ADD COLUMN lastUsedAt BIGINT NOT NULL DEFAULT 0', unless = { column = { 'whip_banking_cards', 'lastUsedAt' } } },
} } }

-- whip_core forgets nothing about tables, but EnsureTable waits for it: run it on every (re)start, in a thread.
Whip.register(function()
    CreateThread(function()
        local ok, why = Whip.core:EnsureTable('whip_banking_cards', CREATE, MIGRATIONS)
        ready = ok == true
        if not ready then print('[whip_banking] Card storage unavailable: ' .. tostring(why)) end
    end)
end)

--- Today's number (UTC days since 1970): a card's spend resets when it changes.
local function today() return os.time() // 86400 end

local function held(source, cardId)
    local items, why = core:FindAllItems(source, item)
    if why or type(items) ~= 'table' then return false end
    for _, entry in ipairs(items) do
        if entry.metadata and entry.metadata.cardId == cardId then return true end
    end
    return false
end

function BankingCards.list(source, charId)
    if not ready then return {}, 'Card service is unavailable.' end
    local rows = MySQL.query.await(
        "SELECT cardId, accountId, status, dailyLimit, spentDay, spentToday, nickname, lastUsedAt FROM whip_banking_cards WHERE charId = ? AND status IN ('active', 'blocked') ORDER BY createdAt",
        { charId })
    if not rows then return {}, 'Card service is unavailable.' end
    for _, card in ipairs(rows) do
        card.lastFour = card.cardId:gsub('%-', ''):sub(-4):upper()
        card.carried = source and held(source, card.cardId) or false
        card.dailyLimit = tonumber(card.dailyLimit) or 0
        card.spentToday = tonumber(card.spentDay) == today() and tonumber(card.spentToday) or 0
        card.spentDay = nil
        card.lastUsedAt = tonumber(card.lastUsedAt) or 0
    end
    return rows
end

function BankingCards.issue(source, player, account, pin, requestId)
    if not ready then return false, 'Card service is unavailable.' end
    if not pin:match('^%d%d%d%d$') then return false, 'Choose a four-digit PIN.' end
    local previous = MySQL.single.await(
        'SELECT accountId, status FROM whip_banking_cards WHERE charId = ? AND requestId = ?',
        { player.charId, requestId })
    if previous then
        if previous.accountId ~= account.accountId then return false, 'This card request was already used.' end
        if previous.status == 'active' or previous.status == 'blocked' then return true end
        return false, 'This card request needs review. Refresh your card list before issuing another.'
    end
    local count = MySQL.scalar.await(
        "SELECT COUNT(*) FROM whip_banking_cards WHERE charId = ? AND accountId = ? AND status IN ('active', 'blocked', 'pending')",
        { player.charId, account.accountId })
    if not count then return false, 'Card service is unavailable.' end
    if count >= 3 then return false, 'This account already has three cards. Revoke a card before issuing another.' end
    local fits, why = core:CanFitItem(source, item, 1)
    if not fits then return false, why end
    local ids = MySQL.single.await('SELECT UUID() AS cardId, UUID() AS salt')
    if not ids then return false, 'Card service is unavailable.' end
    local inserted = MySQL.update.await([[
        INSERT INTO whip_banking_cards (cardId, accountId, charId, pinSalt, pinHash, requestId)
        VALUES (?, ?, ?, ?, SHA2(CONCAT(?, ?), 256), ?)
    ]], { ids.cardId, account.accountId, player.charId, ids.salt, ids.salt, pin, requestId })
    if not inserted then return false, 'Could not issue the card.' end
    if not core:IsSessionCurrent(source, player.session) then
        MySQL.update.await("UPDATE whip_banking_cards SET status = 'revoked' WHERE cardId = ?", { ids.cardId })
        return false, 'Banking session ended.'
    end
    local given, err = core:AddItem(source, item, 1, {
        cardId = ids.cardId, accountNumber = account.accountNumber,
        label = 'Debit card · ' .. account.accountNumber, holder = player.fullName
    }, { noDrop = true, reason = 'Bank debit card issued' })
    if not given then
        MySQL.update.await("UPDATE whip_banking_cards SET status = 'revoked' WHERE cardId = ?", { ids.cardId })
        return false, err
    end
    local activated = MySQL.update.await("UPDATE whip_banking_cards SET status = 'active' WHERE cardId = ?", { ids.cardId })
    if activated ~= 1 then return false, 'Card activation needs staff review. The card cannot be used yet.' end
    return true
end

function BankingCards.manage(charId, accountId, cardId, action)
    if not ready then return false, 'Card service is unavailable.' end
    local status = ({ block = 'blocked', unblock = 'active', revoke = 'revoked' })[action]
    if not status then return false, 'Choose block, unblock or revoke.' end
    local affected = MySQL.update.await([[
        UPDATE whip_banking_cards SET status = ?
        WHERE cardId = ? AND charId = ? AND accountId = ? AND status IN ('active', 'blocked')
    ]], { status, cardId, charId, accountId })
    if affected ~= 1 then return false, 'This card is unavailable.' end
    return true
end

--- A card's daily ATM limit (0: none, the ATM's own per-withdrawal limit still applies).
function BankingCards.setLimit(charId, accountId, cardId, limit)
    if not ready then return false, 'Card service is unavailable.' end
    limit = math.tointeger(tonumber(limit))
    if not limit or limit < 0 or limit > Config.Cards.MaxDailyLimit then
        return false, ('Choose a daily limit from $0 (none) to $%d.'):format(Config.Cards.MaxDailyLimit)
    end
    local affected = MySQL.update.await([[
        UPDATE whip_banking_cards SET dailyLimit = ?
        WHERE cardId = ? AND charId = ? AND accountId = ? AND status IN ('active', 'blocked')
    ]], { limit, cardId, charId, accountId })
    if affected ~= 1 then return false, 'This card is unavailable.' end
    return true
end

function BankingCards.rename(charId, accountId, cardId, name)
    if not ready then return false, 'Card service is unavailable.' end
    name = type(name) == 'string' and name:gsub('%c', ''):match('^%s*(.-)%s*$') or ''
    if #name > 24 then return false, 'Keep the card name under 24 characters.' end
    local affected = MySQL.update.await([[
        UPDATE whip_banking_cards SET nickname = ?
        WHERE cardId = ? AND charId = ? AND accountId = ? AND status IN ('active', 'blocked')
    ]], { name ~= '' and name or nil, cardId, charId, accountId })
    if affected ~= 1 then return false, 'This card is unavailable.' end
    return true
end

--- Claim `amount` of the card's daily limit before the money moves; `unspend` gives it back if the withdrawal fails.
--- One conditional UPDATE, so two ATMs at once cannot both pass the limit.
function BankingCards.spend(cardId, amount)
    if not ready then return false, 'Card service is unavailable.' end
    local day = today()
    local affected = MySQL.update.await([[
        UPDATE whip_banking_cards
        SET spentToday = IF(spentDay = ?, spentToday, 0) + ?, spentDay = ?, lastUsedAt = UNIX_TIMESTAMP()
        WHERE cardId = ? AND status = 'active'
          AND (dailyLimit = 0 OR IF(spentDay = ?, spentToday, 0) + ? <= dailyLimit)
    ]], { day, amount, day, cardId, day, amount })
    if affected ~= 1 then
        local card = MySQL.single.await('SELECT dailyLimit, spentDay, spentToday FROM whip_banking_cards WHERE cardId = ?', { cardId })
        if card and tonumber(card.dailyLimit) > 0 then
            local left = tonumber(card.dailyLimit) - (tonumber(card.spentDay) == day and tonumber(card.spentToday) or 0)
            return false, ('This card can withdraw $%d more today.'):format(math.max(0, left))
        end
        return false, 'This debit card is unavailable.'
    end
    return true
end

function BankingCards.unspend(cardId, amount)
    if not ready then return false end
    return MySQL.update.await([[
        UPDATE whip_banking_cards SET spentToday = IF(spentToday >= ?, spentToday - ?, 0)
        WHERE cardId = ? AND spentDay = ?
    ]], { amount, amount, cardId, today() }) == 1
end

function BankingCards.authorize(source, player, accountId, cardId, pin)
    if not ready then return false, 'Card service is unavailable.' end
    if not held(source, cardId) then return false, 'Carry this debit card in your inventory.' end
    local card = MySQL.single.await([[
        SELECT status, lockedUntil FROM whip_banking_cards
        WHERE cardId = ? AND charId = ? AND accountId = ?
    ]], { cardId, player.charId, accountId })
    if not card or card.status ~= 'active' then return false, 'This debit card is unavailable.' end
    if tonumber(card.lockedUntil) > os.time() then return false, 'Too many PIN attempts. Try again in five minutes.' end
    local matched = MySQL.scalar.await([[
        SELECT COUNT(*) FROM whip_banking_cards
        WHERE cardId = ? AND pinHash = SHA2(CONCAT(pinSalt, ?), 256)
    ]], { cardId, pin })
    if matched ~= 1 then
        MySQL.update.await([[
            UPDATE whip_banking_cards
            SET lockedUntil = IF(attempts >= 2, UNIX_TIMESTAMP() + 300, lockedUntil),
                attempts = IF(attempts >= 2, 0, attempts + 1)
            WHERE cardId = ?
        ]], { cardId })
        return false, 'Incorrect PIN. Three failed attempts lock the card for five minutes.'
    end
    MySQL.update.await('UPDATE whip_banking_cards SET attempts = 0, lockedUntil = 0 WHERE cardId = ?', { cardId })
    return true
end

function BankingCards.valid(source, player, accountId, cardId)
    if not ready or not cardId or not held(source, cardId) then return false end
    return MySQL.scalar.await([[
        SELECT COUNT(*) FROM whip_banking_cards
        WHERE cardId = ? AND charId = ? AND accountId = ? AND status = 'active'
    ]], { cardId, player.charId, accountId }) == 1
end

local function putCardAway(source)
    previewPermits[source] = nil
    core:DropHeldProps(source, 'debit-card')
end

AddEventHandler('whip_core:heldProps:lost', function(event)
    if type(event) == 'table' and event.tag == GetCurrentResourceName() .. ':debit-card' then
        previewPermits[event.source] = nil
        TriggerClientEvent('whip_banking:cardHoldLost', event.source)
    end
end)
AddEventHandler('playerDropped', function() previewPermits[source] = nil end)
AddEventHandler('whip_core:player:logout', function(event) putCardAway(event.source) end)
CreateThread(function()
    while true do
        Wait(1000)
        for source, permit in pairs(previewPermits) do
            if not core:IsSessionCurrent(source, permit.session) or not held(source, permit.cardId)
                or (not permit.holding and os.time() - permit.openedAt > 15) then
                putCardAway(source)
                TriggerClientEvent('whip_banking:cardHoldLost', source)
            end
        end
    end
end)

Whip.register(function()
    Whip.core:SecureCallback('whip_banking:cardHold', { rateLimit = 300, params = {}, sheet = 'light' },
        function(source, player)
            local permit = previewPermits[source]
            if not permit or permit.session ~= player.session or not held(source, permit.cardId) then
                return false, 'Use a debit card from your inventory first.'
            end
            local tag = core:GetHeldPropsTag(source)
            if tag and tag ~= GetCurrentResourceName() .. ':debit-card' then
                return false, 'Put away the item in your hand before showing your card.'
            end
            local prop = Config.CardProp
            local ok, why = core:HoldProps(source, { {
                model = prop.model, bone = prop.bone, offset = prop.offset, rot = prop.rotation
            } }, 'debit-card')
            if ok then permit.holding = true end
            return ok, why
        end)
    Whip.core:SecureEvent('whip_banking:cardPutAway',
        { rateLimit = 100, burst = 6, whileDead = true }, function(source) putCardAway(source) end)
    local ok, why = core:RegisterItem(item, { name = 'Debit Card', weight = 0.01, stack = false, usable = true, cooldown = 1, prop = Config.CardProp.model, image = 'web/assets/whip_debit_card.png' })
    if not ok then print('[whip_banking] Debit card registration failed: ' .. tostring(why)) end
    core:RegisterUseHandler(item, function(source, player, entry)
        if not ready then return false, 'Card service is unavailable.' end
        local cardId = entry and entry.metadata and entry.metadata.cardId
        if type(cardId) ~= 'string' or not held(source, cardId) then return false, 'This debit card is unavailable.' end
        local card = MySQL.single.await(
            'SELECT cardId, accountId, charId, status FROM whip_banking_cards WHERE cardId = ?', { cardId })
        if not card then return false, 'This debit card is unavailable.' end
        local account = core:GetBankAccount(card.accountId)
        if not account then return false, 'This card account is unavailable.' end
        local names = core:GetCharacterNames({ card.charId })
        local holder = names and names[card.charId] or 'Account holder'
        local status = card.status
        if account.frozen == true or account.frozen == 1 then status = 'frozen' end
        if account.closedAt then status = 'closed' end
        if not core:IsSessionCurrent(source, player.session) or not held(source, cardId) then return false end
        previewPermits[source] = { session = player.session, cardId = cardId, openedAt = os.time() }
        TriggerClientEvent('whip_banking:cardUsed', source, {
            holder = holder, accountName = account.label or 'Account',
            accountNumber = account.accountNumber, status = status,
            lastFour = cardId:gsub('%-', ''):sub(-4):upper()
        })
        return false
    end)
end)

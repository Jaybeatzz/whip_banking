local prefix = 'whip_banking:'
local open, opening = false, false
local generation = 0
local keyboardOpening = false
local cardPreview, cardPreviewReady = nil, false
local cardPreviewSequence = 0
local cardPosePed

local function stopCardPose()
    if cardPosePed and Config.CardProp then
        local animation = Config.CardProp.animation
        StopAnimTask(cardPosePed, animation.dict, animation.clip, 2.0)
    end
    cardPosePed = nil
    TriggerServerEvent('whip_banking:cardPutAway')
end
local screen = Whip.padScreen({ buttons = { 'up', 'down', 'left', 'right', 'a', 'b', 'x', 'lb', 'rb' } })
local waitingForRender, pendingMessage

local function release(tellServer)
    if cardPreview then
        stopCardPose()
        cardPreview, cardPreviewReady = nil, false
        screen:close()
        Whip.core:SetScreenOpen(false, 'debit-card')
        SendNUIMessage({ type = 'card:close' })
    end
    generation = generation + 1
    local wasOpen = open or waitingForRender ~= nil
    waitingForRender, pendingMessage = nil, nil
    if open then
        open = false
        screen:close()
        Whip.core:SetScreenOpen(false, 'whip_banking')
    end
    if wasOpen then
        SendNUIMessage({ type = 'bank:close' })
        if tellServer then TriggerServerEvent(prefix .. 'close') end
    end
end

--- Open a branch (`open`, terminal key) or an ATM (`openAtm`, x, y, z): the server answers with the first snapshot.
local function show(name, ...)
    if open or opening or waitingForRender or cardPreview then return end
    if Whip.core:IsAnyScreenOpen() or IsNuiFocused() then return end
    opening = true
    generation = generation + 1
    local version = generation
    local snapshot, why = Whip.core:Callback(prefix .. name, ...)
    opening = false
    if version ~= generation then return end
    if not snapshot then return Whip.core:Notify(why or 'The bank is unavailable.', 'error') end
    waitingForRender = version
    local message = { type = 'bank:open', snapshot = snapshot, generation = version }
    pendingMessage = message
    SendNUIMessage(message)
    for _, delay in ipairs({ 300, 1000, 2500, 5000 }) do
        SetTimeout(delay, function()
            if waitingForRender == version then SendNUIMessage(message) end
        end)
    end
    SetTimeout(8000, function()
        if waitingForRender ~= version then return end
        print('[whip_banking] NUI did not confirm the panel rendered. Check F8 for an NUI error.')
        release(true)
        Whip.core:Notify('The banking panel did not finish loading. Try opening it again.', 'error')
    end)
end

local function closest()
    local coords = GetEntityCoords(PlayerPedId())
    local nearest, distance = nil, Config.InteractionDistance
    for key, terminal in pairs(Config.Terminals) do
        local range = #(coords - terminal.coords)
        if terminal.mode == 'bank' and range <= distance then nearest, distance = key, range end
    end
    return nearest
end

local promptGeneration = 0

local function mountTeller(key, terminal, version)
    local prompt = terminal.prompt or {}
    local actionId = 'whip_banking_' .. key
    local ok, why = Whip.core:AddAction({
        id = actionId,
        at = { coords = prompt.coords or (terminal.coords + vector3(0.0, 0.0, 0.75)), heading = prompt.heading },
        focusMode = 'near', reach = Config.InteractionDistance, seeFrom = 4.5,
        scale = 0.70, label = 'Open Bank', icon = 'bank', press = true,
        require = { alive = true, vehicle = 'out' },
        onSelect = function() show('open', key, 0) end
    })
    if not ok then print(('[whip_banking] Teller %s: %s'):format(key, why)) return end
    if not prompt.findWall or not prompt.heading then return end
    CreateThread(function()
        while version == promptGeneration and #(GetEntityCoords(PlayerPedId()) - terminal.coords) > 25.0 do Wait(1000) end
        if version ~= promptGeneration then return end
        local start = terminal.coords + vector3(0.0, 0.0, 0.75)
        local angle = math.rad(prompt.heading)
        local finish = start + vector3(math.sin(angle), -math.cos(angle), 0.0) * 1.5
        local ray = StartShapeTestRay(start.x, start.y, start.z, finish.x, finish.y, finish.z, 17, PlayerPedId(), 7)
        local status, hit, point, normal
        for _ = 1, 60 do
            status, hit, point, normal = GetShapeTestResult(ray)
            if status ~= 1 then break end
            Wait(0)
        end
        if version ~= promptGeneration or status ~= 2 or not hit or hit == 0 or math.abs(normal.z) > 0.6 then return end
        Whip.core:UpdateAction(actionId, {
            at = { coords = point + normal * 0.025, heading = GetHeadingFromVector_2d(normal.x, normal.y) }
        })
    end)
end

Whip.register(function()
    promptGeneration = promptGeneration + 1
    local version = promptGeneration
    for key, terminal in pairs(Config.Terminals) do
        if terminal.mode == 'bank' then mountTeller(key, terminal, version) end
    end
    -- ATMs are whip_core's own (its built-in ATM); this resource runs the branches.

end)

-- A blip on the map for every branch. Blips belong to this resource: FiveM removes them when it stops.
CreateThread(function()
    local b = Config.Blips
    if not b or not b.enabled then return end
    for _, terminal in pairs(Config.Terminals) do
        if terminal.mode == 'bank' then
            local blip = AddBlipForCoord(terminal.coords.x, terminal.coords.y, terminal.coords.z)
            SetBlipSprite(blip, b.sprite)
            SetBlipColour(blip, b.colour)
            SetBlipScale(blip, b.scale)
            SetBlipAsShortRange(blip, true)
            BeginTextCommandSetBlipName('STRING')
            AddTextComponentSubstringPlayerName(b.label)
            EndTextCommandSetBlipName(blip)
        end
    end
end)

RegisterCommand('bank', function()
    local terminal = closest()
    if not terminal then return Whip.core:Notify('Move to a bank branch to use banking.', 'error') end
    show('open', terminal, 0)
end, false)

local function respond(cb, value, why)
    if value == nil or value == false then
        return cb({ ok = false, error = { message = why or 'The request could not be completed.' } })
    end
    cb({ ok = true, data = value ~= true and value or nil })
end

RegisterNUICallback('uiError', function(data, cb)
    if type(data) == 'table' and type(data.message) == 'string' then
        print(('[whip_banking] NUI error: %s'):format(data.message:sub(1, 400):gsub('%c', ' ')))
    end
    respond(cb, true)
end)

RegisterNUICallback('ready', function(_, cb)
    respond(cb, pendingMessage or cardPreview or true)
end)

RegisterNUICallback('rendered', function(data, cb)
    if not waitingForRender or type(data) ~= 'table' or data.generation ~= waitingForRender then
        return respond(cb, false, 'This banking window is no longer active.')
    end
    if Whip.core:IsAnyScreenOpen() or IsNuiFocused() then
        release(true)
        return respond(cb, false, 'Close the other screen and try again.')
    end
    local ok, why = Whip.core:SetScreenOpen(true, 'whip_banking')
    if not ok then
        release(true)
        return respond(cb, false, why or 'Could not open banking.')
    end
    waitingForRender, pendingMessage = nil, nil
    open = true
    local pad = screen:open()
    respond(cb, { pad = pad })
end)

RegisterNUICallback('editField', function(data, cb)
    if not open or keyboardOpening then return respond(cb, false, 'Banking input is unavailable.') end
    local fields = {
        amount = { title = 'Amount in dollars', numeric = true, maxLength = 13 },
        recipient = { title = 'Recipient account', maxLength = 16, predict = false },
        ['account-name'] = { title = 'Account name', maxLength = 50 },
        ['vault-name'] = { title = 'Vault name', maxLength = 40 },
        ['vault-goal'] = { title = 'Savings goal in dollars', numeric = true, maxLength = 10 },
        ['vault-amount'] = { title = 'Amount in dollars', numeric = true, maxLength = 10 },
        ['vault-lock'] = { title = 'Lock for how many days', numeric = true, maxLength = 3 },
        ['so-label'] = { title = 'What is it for', maxLength = 60 },
        ['so-amount'] = { title = 'Amount each time', numeric = true, maxLength = 10 },
        ['so-number'] = { title = 'Pay account number', maxLength = 16, predict = false },
        ['so-runs'] = { title = 'How many payments (empty: until stopped)', numeric = true, maxLength = 4 },
        ['card-limit'] = { title = 'Daily ATM limit (0 for none)', numeric = true, maxLength = 10 },
        ['card-name'] = { title = 'Card name', maxLength = 24 },
        ['atm-amount'] = { title = 'Cash amount', numeric = true, maxLength = 10 }
    }
    local opts = type(data) == 'table' and fields[data.field]
    if not opts then return respond(cb, false, 'This field is unavailable.') end
    if data.field == 'amount' then
        local title = ({ deposit = 'Deposit', withdraw = 'Withdraw', transfer = 'Transfer' })[data.action] or 'Amount'
        local account = type(data.accountName) == 'string' and data.accountName:sub(1, 50) or 'Account'
        opts.title = title .. ' · ' .. account
    end
    opts.value = type(data.value) == 'string' and data.value:sub(1, opts.maxLength) or ''
    local version = generation
    keyboardOpening = true
    CreateThread(function()
        local ran, text = pcall(function() return Whip.core:OpenKeyboard(opts) end)
        keyboardOpening = false
        if version ~= generation then return respond(cb, false, 'This banking window closed.') end
        if not ran then return respond(cb, false, 'The keyboard could not open.') end
        respond(cb, { cancelled = text == nil, value = text })
    end)
end)

RegisterNUICallback('close', function(_, cb)
    release(true)
    respond(cb, true)
end)

local insertAnim = 0
local calls = {
    plus = function(data)
        return Whip.core:Callback(prefix .. 'plus', data.action, type(data.args) == 'table' and data.args or {})
    end,
    insertCard = function(data)
        local result, why = Whip.core:Callback(prefix .. 'insertCard', tonumber(data.accountId), data.cardId)
        if not result then return false, why end
        local insert = Config.CardInsertion
        if Whip.core:LoadAnimDict(insert.dict) then
            insertAnim = insertAnim + 1
            local mine, ped = insertAnim, PlayerPedId()
            TaskPlayAnim(ped, insert.dict, insert.clip, 4.0, -4.0, insert.duration, 48, 0.0, false, false, false)
            SetTimeout(insert.duration, function()
                if mine == insertAnim then StopAnimTask(ped, insert.dict, insert.clip, 2.0) end
            end)
        end
        Wait(math.min(insert.duration, 1600))
        return result
    end,
    ejectCard = function()
        return Whip.core:Callback(prefix .. 'ejectCard')
    end,
    issueCard = function(data)
        return Whip.core:Callback(prefix .. 'issueCard', tonumber(data.accountId), data.pin, data.requestId)
    end,
    manageCard = function(data)
        return Whip.core:Callback(prefix .. 'manageCard', tonumber(data.accountId), data.cardId, data.action)
    end,
    unlockCard = function(data)
        return Whip.core:Callback(prefix .. 'unlockCard', tonumber(data.accountId), data.cardId, data.pin)
    end,
    createAccount = function(data)
        return Whip.core:Callback(prefix .. 'createAccount', data.label, data.kind)
    end,
    getBankSnapshot = function(data)
        return Whip.core:Callback(prefix .. 'getBankSnapshot', tonumber(data.accountId) or 0)
    end,
    getStatement = function(data)
        return Whip.core:Callback(prefix .. 'getStatement', tonumber(data.accountId), data.page)
    end,
    resolveRecipient = function(data)
        return Whip.core:Callback(prefix .. 'resolveRecipient', tonumber(data.accountId), data.accountNumber, data.amount)
    end,
    deposit = function(data)
        return Whip.core:Callback(prefix .. 'deposit', tonumber(data.accountId), data.amount, data.requestId)
    end,
    withdraw = function(data)
        return Whip.core:Callback(prefix .. 'withdraw', tonumber(data.accountId), data.amount, data.requestId)
    end,
    transfer = function(data)
        return Whip.core:Callback(prefix .. 'transfer', tonumber(data.accountId), data.amount, data.requestId, data.recipientToken)
    end
}

for name, call in pairs(calls) do
    RegisterNUICallback(name, function(data, cb)
        if not open then return respond(cb, false, 'Open the banking terminal again.') end
        local version = generation
        CreateThread(function()
            local ran, value, why = pcall(call, type(data) == 'table' and data or {})
            if not ran then
                print(('[whip_banking] NUI %s: %s'):format(name, value))
                return respond(cb, false, 'The banking request was interrupted.')
            end
            if version ~= generation then return respond(cb, false, 'This banking window closed.') end
            if why == 'No answer from the server' then
                why = 'No confirmation received. Check your statement or retry the same confirmation.'
            end
            respond(cb, value, why)
        end)
    end)
end

AddEventHandler('whip_core:player:logout', function() release(false) end)
AddEventHandler('onClientResourceStop', function(resource)
    if resource == GetCurrentResourceName() then release(false) end
end)

RegisterNetEvent('whip_banking:cardUsed', function(data)
    if type(data) ~= 'table' or open or opening or waitingForRender then return end
    Whip.core:CloseInventory()
    if Whip.core:IsAnyScreenOpen() or (IsNuiFocused() and not cardPreview) then return end
    cardPreviewSequence = cardPreviewSequence + 1
    local sequence = cardPreviewSequence
    cardPreview = { type = 'card:open', card = data, sequence = sequence }
    SendNUIMessage(cardPreview)
    SetTimeout(8000, function()
        if cardPreview and cardPreview.sequence == sequence and not cardPreviewReady then release(false) end
    end)
end)

RegisterNUICallback('cardReady', function(data, cb)
    if not cardPreview or type(data) ~= 'table' or data.sequence ~= cardPreview.sequence then
        return respond(cb, false, 'This card preview closed.')
    end
    if not cardPreviewReady then
        if Whip.core:IsAnyScreenOpen() or IsNuiFocused() then
            release(false)
            return respond(cb, false, 'Close the other screen and try again.')
        end
        local ok = Whip.core:SetScreenOpen(true, 'debit-card')
        if not ok then release(false) return respond(cb, false, 'Could not show the card.') end
        cardPreviewReady = true
    end
    local sequence = cardPreview.sequence
    CreateThread(function()
        local animation = Config.CardProp.animation
        local loaded = Whip.core:LoadAnimDict(animation.dict)
        if not loaded or not cardPreview or cardPreview.sequence ~= sequence then
            release(false)
            return respond(cb, false, 'The card animation could not load.')
        end
        local held, why = Whip.core:Callback('whip_banking:cardHold')
        if not held or not cardPreview or cardPreview.sequence ~= sequence then
            stopCardPose()
            release(false)
            return respond(cb, false, why or 'The card preview closed.')
        end
        cardPosePed = PlayerPedId()
        TaskPlayAnim(cardPosePed, animation.dict, animation.clip, 4.0, -4.0, -1, 49, 0.0, false, false, false)
        respond(cb, { pad = screen:open() })
    end)
end)

RegisterNUICallback('cardClose', function(_, cb)
    if cardPreview then
        stopCardPose()
        cardPreview, cardPreviewReady = nil, false
        screen:close()
        Whip.core:SetScreenOpen(false, 'debit-card')
        SendNUIMessage({ type = 'card:close' })
    end
    respond(cb, true)
end)

RegisterNetEvent('whip_banking:cardHoldLost', function() release(false) end)
AddEventHandler('whip_core:player:died', function() release(true) end)

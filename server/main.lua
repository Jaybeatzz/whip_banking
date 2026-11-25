local core = exports.whip_core
local prefix = 'whip_banking:'
local terminals, receipts, busy = {}, {}, {}
local pageSize = 12
local insertions = {}
local atmOrigins = {}

local function near(source, terminal)
    local ped = GetPlayerPed(source)
    return ped ~= 0 and GetVehiclePedIsIn(ped, false) == 0 and GetPlayerRoutingBucket(source) == Config.RoutingBucket
        and #(GetEntityCoords(ped) - terminal.coords) <= Config.InteractionDistance
end

local function sameSession(source, player)
    return core:IsSessionCurrent(source, player.session)
end

local function activeTerminal(source, player)
    local session = terminals[source]
    if session and session.characterSession == player.session and near(source, session.terminal)
        and sameSession(source, player) then return session end
    return false, 'Move back to the terminal and open banking again.'
end

local function accountFor(player, id, role)
    local account = core:GetBankAccount(id)
    if not account then
        return false, 'This account is unavailable.'
    end
    local allowed, why = core:CanUseBankAccount(id, { charId = player.charId }, role)
    if not allowed then return false, why end
    return account
end

local function history(id, limit, offset)
    local rows, why = core:GetBankTransactions(id, limit, offset)
    if why or type(rows) ~= 'table' then return false, why or 'The statement is unavailable.' end
    local items = {}
    for _, tx in ipairs(rows) do
        local outgoing = tonumber(tx.fromAccountId) == id
        local amount = tonumber(tx.amount) or 0
        items[#items + 1] = {
            id = tostring(tx.txId),
            date = os.date('!%Y-%m-%dT%H:%M:%SZ', tonumber(tx.createdAt) or 0),
            description = tx.message and tx.message ~= '' and tx.message
                or ({ deposit = 'Deposit', withdraw = 'Withdrawal', transfer = 'Transfer', payment = 'Payment' })[tx.type]
                or 'Transaction',
            amount = outgoing and -amount or amount,
            balance = outgoing and tonumber(tx.fromBalance) or (not outgoing and tonumber(tx.toBalance) or nil),
            type = tx.type
        }
    end
    return items
end

local function snapshot(source, player, session, selectedId)
    local accounts, selected, default = {}, nil, nil
    local list, why = core:GetCharacterBankAccounts(player.charId)
    if why or type(list) ~= 'table' then return false, why or 'Accounts are unavailable.' end
    for _, a in ipairs(list) do
        if core:CanUseBankAccount(a.accountId, { charId = player.charId }, 'view') then
            local balance, err = core:GetBalance({ accountId = a.accountId })
            if balance == false or balance == nil then return false, err or 'Balance unavailable.' end
            local row = { id = tostring(a.accountId), name = a.label or 'Personal account',
                number = a.accountNumber, balance = balance, type = a.type, role = a.role,
                canDeposit = core:CanUseBankAccount(a.accountId, { charId = player.charId }, 'deposit'),
                canWithdraw = core:CanUseBankAccount(a.accountId, { charId = player.charId }, 'withdraw'),
                frozen = a.frozen == true or a.frozen == 1 }
            accounts[#accounts + 1] = row
            if a.accountId == selectedId then selected = row end
            if a.isDefault == true or a.isDefault == 1 then default = row end
        end
    end
    if selectedId ~= 0 and not selected then return false, 'This account is unavailable.' end
    selected = selected or default or accounts[1]
    local recent = {}
    local unlocked = session.terminal.mode == 'atm' and selected and session.atmAccountId == tonumber(selected.id)
    if selected and (session.terminal.mode == 'bank' or unlocked) then
        local id = tonumber(selected.id)
        local allowed, refusal = core:CanUseBankAccount(id, { charId = player.charId }, 'view')
        if not allowed then return false, refusal end
        local rows, err = history(id, 5, 0)
        if not rows then return false, err end
        recent = rows
    end
    if not sameSession(source, player) or not near(source, session.terminal) then
        return false, 'Banking session ended.'
    end
    local cash, err = core:GetItemCount(source, 'cash')
    if type(cash) ~= 'number' then return false, err or 'Cash balance unavailable.' end
    local readCards, cards, cardError = pcall(BankingCards.list, source, player.charId)
    if not readCards then cards, cardError = {}, 'Card service is unavailable.' end
    local plus
    if session.terminal.mode == 'bank' then
        plus = BankingPlus.run(source, player, 'overview', {}) or nil
    end
    return {
        plus = plus, bank = { name = Config.BankName, tagline = Config.BankTagline, colour = Config.BankColour, branch = session.terminal.label },
        fastCash = Config.AtmFastCash,
        insertedCardId = session.inserted and session.inserted.cardId or '',
        cards = cards, cardError = cardError,
        atmAccountId = session.atmAccountId and tostring(session.atmAccountId) or '',
        characterId = tostring(player.charId), characterName = player.fullName,
        mode = session.terminal.mode, cash = cash, theme = core:GetActiveTheme(),
        limit = session.terminal.mode == 'atm' and Config.MaxAtmWithdrawal or Config.MaxTransaction,
        accounts = accounts,
        selectedAccountId = selected and selected.id or '',
        recent = recent
    }
end

local function compensate(ok, why, source, accountId, amount, operation)
    if ok then return true end
    print(('[whip_banking] %s reconciliation needed (source %s, account %d, amount %d): %s')
        :format(operation, source, accountId, amount, tostring(why)))
    return false, 'This transaction needs staff review. Check your statement before trying again.'
end

local function deposit(source, player, id, amount)
    local receipt, why = core:ChargePlayer(source, amount, { method = 'cash', reason = 'Bank cash deposit' })
    if not receipt then return false, why end
    local ok, err
    if sameSession(source, player) then
        ok, err = core:BankDeposit(id, amount, { charId = player.charId }, { reason = 'Cash deposit' })
    end
    if ok then return true end
    local refunded, refundWhy = core:RefundPlayer(receipt)
    local restored, restoreWhy = compensate(refunded, refundWhy, source, id, amount, 'Deposit')
    return false, restored and (err or 'Banking session ended.') or restoreWhy
end

local function withdraw(source, player, id, amount, mode)
    local fits, why = core:CanFitItem(source, 'cash', amount)
    if not fits then return false, why end
    if not sameSession(source, player) then return false, 'Banking session ended.' end
    local ok, err = core:BankWithdraw(id, amount, { charId = player.charId },
        { reason = mode == 'atm' and 'ATM withdrawal' or 'Cash withdrawal' })
    if not ok then return false, err end
    local given, giveWhy
    if sameSession(source, player) then
        given, giveWhy = core:AddItem(source, 'cash', amount, nil, { reason = 'Bank cash withdrawal', noDrop = true })
    end
    if given then return true end
    local refunded, refundWhy = core:BankSystemDeposit(id, amount,
        { reason = 'Withdrawal reversal', actorCharId = player.charId })
    local restored, restoreWhy = compensate(refunded, refundWhy, source, id, amount, 'Withdrawal')
    return false, restored and (giveWhy or 'Banking session ended.') or restoreWhy
end

local function transfer(_, player, id, amount, recipient)
    return core:BankTransfer(id, recipient.id, amount, { charId = player.charId }, { reason = 'Bank transfer' })
end

local handlers = { deposit = deposit, withdraw = withdraw, transfer = transfer }

local function move(source, player, action, id, amount, request, token)
    local session, why = activeTerminal(source, player)
    if not session then return false, why end
    local mode = session.terminal.mode
    if mode == 'atm' and action ~= 'withdraw' then return false, 'This ATM only supports withdrawals.' end
    if mode == 'atm' and (session.atmAccountId ~= id or
        not BankingCards.valid(source, player, id, session.atmCardId)) then
        return false, 'Insert a debit card and verify its PIN before withdrawing.'
    end
    local receiptSet = receipts[source]
    if not receiptSet or receiptSet.session ~= player.session then
        receiptSet = { session = player.session, requests = {}, order = {} }
        receipts[source] = receiptSet
    end
    local previous = receiptSet.requests[request]
    if previous then
        if previous.action == action and previous.id == id and previous.amount == amount and previous.token == token then
            return true
        end
        return false, 'This request ID has already been used.'
    end
    local limit = mode == 'atm' and Config.MaxAtmWithdrawal or Config.MaxTransaction
    if amount > limit then return false, ('The limit per transaction is $%d.'):format(limit) end
    if busy[player.charId] then return false, 'A banking transaction is still in progress.' end
    busy[player.charId] = true
    local ran, ok, err = pcall(function()
        local account, refusal = accountFor(player, id, action == 'deposit' and 'deposit' or 'withdraw')
        if not account then return false, refusal end
        if account.frozen == true or account.frozen == 1 then return false, 'This account is frozen.' end
        if action ~= 'deposit' then
            local locked = BankingPlus.lockedWhy(id)
            if locked then return false, locked end
        end
        local recipient = session.recipient
        if action == 'transfer' and (not recipient or recipient.token ~= token or recipient.from ~= id
            or recipient.amount ~= amount or recipient.expires <= os.time()) then
            return false, 'Recipient confirmation expired. Find the recipient again.'
        end
        if activeTerminal(source, player) ~= session then return false, 'Banking session ended.' end
        if mode ~= 'atm' then
            return handlers[action](source, player, id, amount, action == 'withdraw' and mode or recipient)
        end
        -- An ATM: the card's daily limit is claimed first and given back if the cash never comes out.
        local cardId = session.atmCardId
        local spent, spendWhy = BankingCards.spend(cardId, amount)
        if not spent then return false, spendWhy end
        local done, doneWhy = handlers.withdraw(source, player, id, amount, mode)
        if not done then BankingCards.unspend(cardId, amount) end
        return done, doneWhy
    end)
    busy[player.charId] = nil
    if not ran then
        print(('[whip_banking] %s request %s failed for character %d: %s'):format(action, request, player.charId, ok))
        return false, 'Transaction interrupted. Check your statement before attempting it again.'
    end
    if not ok then return false, err end
    if action == 'transfer' then session.recipient = nil end
    receiptSet.requests[request] = { action = action, id = id, amount = amount, token = token }
    local order = receiptSet.order
    order[#order + 1] = request
    if #order > 256 then receiptSet.requests[table.remove(order, 1)] = nil end
    return true
end

local function declare(name, delay, params, handler)
    local ok, why = Whip.core:SecureCallback(prefix .. name,
        { rateLimit = delay, params = params, sheet = 'light' }, handler)
    if not ok then print(('[whip_banking] %s: %s'):format(name, why)) end
end

local accountId = { 'account', 'id' }
local amount = { 'amount', 'amount', 1000000000 }
local requestId = { 'request', 'key', 64 }

Whip.register(function()
    declare('open', 500, { { 'terminal', 'key', 48 }, { 'account', 'id', 0 } }, function(source, player, key, selectedId)
        local terminal = Config.Terminals[key]

        if not terminal or terminal.mode ~= 'bank' or not near(source, terminal) then return false, 'Move closer to a bank branch.' end
        local session = { terminal = terminal, characterSession = player.session, sequence = 0 }
        local data, why = snapshot(source, player, session, selectedId or 0)
        if not data then return false, why end
        terminals[source] = session
        atmOrigins[source] = nil
        return data
    end)

    declare('getBankSnapshot', 400, { { 'account', 'id', 0 } }, function(source, player, id)
        local session, why = activeTerminal(source, player)
        if not session then return false, why end
        return snapshot(source, player, session, id)
    end)

    declare('createAccount', 1500, { { 'label', 'string', 50 }, { 'kind', 'key', 16 } }, function(source, player, label, kind)
        local session, why = activeTerminal(source, player)
        if not session then return false, why end
        if session.terminal.mode ~= 'bank' then return false, 'Open accounts at a bank branch.' end
        if kind ~= 'savings' and kind ~= 'shared' then return false, 'Choose savings or shared.' end
        label = label:match('^%s*(.-)%s*$')
        if label == '' or label:find('%c') then return false, 'Enter an account name.' end
        if busy[player.charId] then return false, 'An account request is in progress.' end
        busy[player.charId] = true
        local ran, account, err = pcall(function()
            return core:CreateBankAccount({ charId = player.charId }, label, { type = kind })
        end)
        busy[player.charId] = nil
        if not ran then return false, 'Could not create the account. Refresh your account list before retrying.' end
        if not account then return false, err end
        return { accountId = tostring(account.accountId) }
    end)

    declare('issueCard', 1500, { accountId, { 'pin', 'string', 4 }, requestId }, function(source, player, id, pin, request)
        local session, why = activeTerminal(source, player)
        if not session then return false, why end
        if session.terminal.mode ~= 'bank' then return false, 'Issue cards at a bank branch.' end
        local account, err = accountFor(player, id, 'withdraw')
        if not account then return false, err end
        if account.frozen == true or account.frozen == 1 then return false, 'This account is frozen.' end
        if busy[player.charId] then return false, 'A banking request is in progress.' end
        busy[player.charId] = true
        local ran, ok, refusal = pcall(BankingCards.issue, source, player, account, pin, request)
        busy[player.charId] = nil
        if not ran then return false, 'Card request interrupted. Refresh cards before retrying.' end
        return ok, refusal
    end)
    declare('manageCard', 750, { accountId, { 'card', 'key', 36 }, { 'action', 'key', 12 } },
        function(source, player, id, cardId, action)
            local session, why = activeTerminal(source, player)
            if not session then return false, why end
            if session.terminal.mode ~= 'bank' then return false, 'Manage cards at a bank branch.' end
            local account, err = accountFor(player, id, 'view')
            if not account then return false, err end
            return BankingCards.manage(player.charId, id, cardId, action)
        end)
    declare('unlockCard', 1000, { accountId, { 'card', 'key', 36 }, { 'pin', 'string', 4 } },
        function(source, player, id, cardId, pin)
            local session, why = activeTerminal(source, player)
            if not session then return false, why end
            if session.terminal.mode == 'atm' and (not session.inserted or session.inserted.cardId ~= cardId
                or session.inserted.accountId ~= id) then
                return false, 'Insert this card into the ATM first.'
            end
            local account, err = accountFor(player, id, 'withdraw')
            if not account then return false, err end
            local ok, refusal = BankingCards.authorize(source, player, id, cardId, pin)
            if not ok then return false, refusal end
            if activeTerminal(source, player) ~= session then return false, 'Banking session ended.' end
            session.atmAccountId, session.atmCardId = id, cardId
            return true
        end)

    -- An ATM: the prompt's point (the client found the prop). The player must stand at it, on foot, in the
    -- ATM bucket. An ATM only ever pays out the player's own money against their own card and PIN, so a point
    -- that is not really an ATM gains nothing over the real one.
    declare('openAtm', 750, { { 'x', 'number', -20000, 20000 }, { 'y', 'number', -20000, 20000 }, { 'z', 'number', -500, 2000 } },
        function(source, player, x, y, z)
            local terminal = { mode = 'atm', coords = vector3(x, y, z) }
            if not near(source, terminal) then return false, 'Move closer to the ATM.' end
            local session = { terminal = terminal, characterSession = player.session, sequence = 0 }
            local data, why = snapshot(source, player, session, 0)
            if not data then return false, why end
            terminals[source] = session
            atmOrigins[source] = terminal.coords
            return data
        end)

    -- Put a carried card into the machine: it shows in the hand for the insert, then is "in" the ATM until ejected.
    declare('insertCard', 1000, { accountId, { 'card', 'key', 36 } }, function(source, player, id, cardId)
        local session, why = activeTerminal(source, player)
        if not session then return false, why end
        if session.terminal.mode ~= 'atm' then return false, 'Use an ATM to insert a card.' end
        if not BankingCards.valid(source, player, id, cardId) then return false, 'This debit card cannot be used.' end
        session.inserted = { accountId = id, cardId = cardId }
        session.atmAccountId, session.atmCardId = nil, nil
        local insert = Config.CardInsertion
        local held = core:HoldProps(source, { {
            model = Config.CardProp.model, bone = insert.bone, offset = insert.offset, rot = insert.rotation
        } }, 'atm-card')
        if held then
            local stamp = player.session
            SetTimeout(insert.duration, function()
                if core:IsSessionCurrent(source, stamp) then core:DropHeldProps(source, 'atm-card') end
            end)
        end
        return { duration = insert.duration }
    end)

    declare('ejectCard', 300, {}, function(source, player)
        local session, why = activeTerminal(source, player)
        if not session then return false, why end
        session.inserted, session.atmAccountId, session.atmCardId = nil, nil, nil
        core:DropHeldProps(source, 'atm-card')
        return true
    end)

    -- The new features at a branch: vaults, standing orders, requests, insights, card controls.
    local branchActions = { overview = true, vaultCreate = true, vaultEdit = true, vaultMove = true, vaultClose = true,
        scheduleCreate = true, scheduleControl = true, requestPay = true, requestAnswer = true, insights = true,
        cardControl = true }
    declare('plus', 600, { { 'action', 'key', 24 }, { 'args', 'any' } }, function(source, player, action, args)
        local session, why = activeTerminal(source, player)
        if not session then return false, why end
        if session.terminal.mode ~= 'bank' then return false, 'Visit a bank branch for this.' end
        if not branchActions[action] then return false, 'This is not available at the branch.' end
        local result, err = BankingPlus.run(source, player, action, args)
        if not result then return false, err end
        if activeTerminal(source, player) ~= session then return false, 'Banking session ended.' end
        return result
    end)

    declare('getStatement', 400, { accountId, { 'page', 'id', 1, 1000 } }, function(source, player, id, page)
        local session, why = activeTerminal(source, player)
        if not session then return false, why end
        if session.terminal.mode ~= 'bank' then return false, 'Statements are available at a bank branch.' end
        local account, refusal = accountFor(player, id, 'view')
        if not account then return false, refusal end
        local items, err = history(id, pageSize + 1, (page - 1) * pageSize)
        if not items then return false, err end
        if activeTerminal(source, player) ~= session then return false, 'Banking session ended.' end
        local more = #items > pageSize and page < 1000
        if #items > pageSize then table.remove(items) end
        return { items = items, page = page, hasMore = more }
    end)

    declare('resolveRecipient', 750, { accountId, { 'number', 'string', 16 }, amount },
        function(source, player, id, number, value)
            local session, why = activeTerminal(source, player)
            if not session then return false, why end
            if session.terminal.mode ~= 'bank' then return false, 'Transfers are available at a bank branch.' end
            if value > Config.MaxTransaction then return false, ('The limit per transaction is $%d.'):format(Config.MaxTransaction) end
            local from, refusal = accountFor(player, id, 'withdraw')
            if not from then return false, refusal end
            number = number:upper():match('^%s*(.-)%s*$')
            if not number:match('^WB%-%d%d%d%d%d%d$') then return false, 'Enter an account number like WB-123456.' end
            local to = core:GetBankAccount({ number = number })
            if not to or to.accountId == id or to.frozen == true or to.frozen == 1 then
                return false, 'This recipient account is unavailable.'
            end
            local name = to.type == 'business' and (to.label or 'Business account') or 'Account'
            if to.ownerCharId == player.charId then
                name = to.label or 'Your personal account'
            elseif to.ownerCharId and core:CanSeePlayerName(source, { charId = to.ownerCharId }) then
                local names = core:GetCharacterNames({ to.ownerCharId })
                name = names and names[to.ownerCharId] or name
            end
            if activeTerminal(source, player) ~= session then return false, 'Banking session ended.' end
            session.sequence = session.sequence + 1
            local token = ('%d-%d-%d'):format(GetGameTimer(), player.session, session.sequence)
            session.recipient = { token = token, id = to.accountId, from = id, amount = value, expires = os.time() + 60 }
            return { token = token, name = name, maskedNumber = 'WB-••' .. number:sub(-4) }
        end)

    declare('deposit', 1000, { accountId, amount, requestId }, function(source, player, id, value, request)
        return move(source, player, 'deposit', id, value, request)
    end)
    declare('withdraw', 1000, { accountId, amount, requestId }, function(source, player, id, value, request)
        return move(source, player, 'withdraw', id, value, request)
    end)
    declare('transfer', 1000, { accountId, amount, requestId, { 'token', 'key', 64 } },
        function(source, player, id, value, request, token)
            return move(source, player, 'transfer', id, value, request, token)
        end)
    local ok, why = Whip.core:SecureEvent(prefix .. 'close', { rateLimit = 250, burst = 4, whileDead = true },
        function(source)
            terminals[source] = nil
            core:DropHeldProps(source, 'atm-card')
        end)
    if not ok then print(('[whip_banking] close: %s'):format(why)) end
end)

local function clear(source)
    atmOrigins[source] = nil
    insertions[source] = nil
    core:DropHeldProps(source, 'atm-card')
    terminals[source] = nil
    receipts[source] = nil
end

AddEventHandler('whip_core:player:logout', function(event) clear(event.source) end)
AddEventHandler('playerDropped', function() clear(source) end)

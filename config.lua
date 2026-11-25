Config = {
    -- The branded name every screen shows (teller, ATM, phone app, statements).
    BankName = 'Bank',
    BankTagline = 'Personal & Business Banking',
    BankColour = '#1f9e74',          -- the bank's own colour: cards, seal, security print (any #rrggbb)

    CardProp = {
        model = 'banking_debit_card',
        bone = 28422,
        offset = { 0.042793, 0.012364, -0.033598 },
        rotation = { -10.8683, -177.8499, 23.6377 },
        animation = { dict = 'paper_1_rcm_alt1-8', clip = 'player_one_dual-8' }
    },

    -- ATMs: every prop of these models gets a "Use ATM" prompt. The prompt sits `offset` from the prop's origin in
    -- its own space (x across, y out of its face, z up).
    AtmModels = { 'prop_atm_01', 'prop_atm_02', 'prop_atm_03', 'prop_fleeca_atm' },
    AtmPrompt = { offset = vector3(0.0, -0.05, 1.05) },
    CardInsertion = {
        dict = 'amb@prop_human_atm@male@enter', clip = 'enter', duration = 1500,
        bone = 28422, offset = { 0.1, 0.03, -0.05 }, rotation = { 0.0, 0.0, 180.0 }
    },
    AtmFastCash = { 20, 50, 100, 200, 500, 1000 },


    MaxTransaction = 100000,
    MaxAtmWithdrawal = 10000,
    InteractionDistance = 2.0,
    RoutingBucket = 0,

    -- Every bank branch on the map. `coords`: where the player stands at the teller (the server checks they are
    -- within InteractionDistance of it). `label`: the branch's name, on its blip and in the session bar.
    -- `prompt.heading` + `findWall`: the prompt snaps onto the counter glass in that direction. Without them it floats
    -- just above `coords`. Stand at a teller and use /w (copy coords with G) to fine-tune a spot.
    Terminals = {
        legion_bank = { mode = 'bank', label = 'Legion Square', coords = vector3(149.91, -1040.46, 29.37),
            prompt = { coords = vector3(149.65, -1041.15, 30.10), heading = 340.0, findWall = true } },
        alta_bank = { mode = 'bank', label = 'Alta', coords = vector3(314.23, -278.83, 54.17) },
        burton_bank = { mode = 'bank', label = 'Burton', coords = vector3(-350.80, -49.57, 49.04) },
        rockford_bank = { mode = 'bank', label = 'Rockford Hills', coords = vector3(-1213.00, -330.39, 37.79) },
        great_ocean_bank = { mode = 'bank', label = 'Great Ocean Highway', coords = vector3(-2962.71, 482.97, 15.70) },
        harmony_bank = { mode = 'bank', label = 'Route 68', coords = vector3(1175.06, 2706.64, 38.09) },
        pacific_bank = { mode = 'bank', label = 'Pacific Standard', coords = vector3(241.73, 220.71, 106.29) },
        paleto_bank = { mode = 'bank', label = 'Paleto Bay', coords = vector3(-113.22, 6470.03, 31.63) },
    },

    -- Map blips for every branch above.
    Blips = { enabled = true, sprite = 108, colour = 2, scale = 0.8, label = 'Bank' },

    -- Savings vaults: real savings accounts with a goal, an optional time lock, and interest.
    Vaults = {
        Max = 3,                    -- per character (they count towards whip_core's savings/shared account limit)
        InterestBasisPoints = 50,   -- 50 = 0.50% of the balance per payout
        InterestEveryHours = 24,
        InterestCap = 500,          -- most one payout can be
        MinBalance = 100,           -- no interest below this
        OnlineOnly = true,          -- pay only while the owner is in the city
        MaxLockDays = 30,
    },

    -- Standing orders: money that moves by itself on a schedule.
    Schedules = {
        Max = 10,
        Intervals = { 1, 6, 24, 72, 168 },   -- hours a player can pick from
        MaxFailures = 3,                       -- in a row, then it pauses
        TickSeconds = 60,
    },

    -- Pay requests and bill splitting, sent phone to phone.
    Requests = {
        MaxPendingOut = 15,
        ExpireHours = 48,
        MaxSplit = 8,          -- people in one split
        AgainSeconds = 10,     -- after a decline, wait before asking the same person again
    },

    -- Debit card controls.
    Cards = {
        MaxDailyLimit = 50000,
    },

    -- Spending insights: a transaction's statement text, lower-cased, is matched against these words (first match wins).
    Categories = {
        { id = 'food', label = 'Food & drink', words = { 'food', 'cafe', 'coffee', 'burger', 'pizza', 'restaurant', 'bar', 'drink', 'diner', 'taco' } },
        { id = 'vehicles', label = 'Vehicles & fuel', words = { 'fuel', 'gas', 'garage', 'vehicle', 'car', 'repair', 'tuning', 'impound', 'dealership', 'parking' } },
        { id = 'housing', label = 'Housing', words = { 'rent', 'property', 'house', 'home', 'apartment', 'mortgage' } },
        { id = 'bills', label = 'Bills & fines', words = { 'fine', 'bill', 'tax', 'fee', 'invoice', 'ticket', 'phone' } },
        { id = 'shopping', label = 'Shopping', words = { 'shop', 'store', 'purchase', 'market', 'clothing', 'ammu', 'sale' } },
        { id = 'savings', label = 'Savings', words = { 'vault', 'savings' } },
        { id = 'people', label = 'People', words = { 'request', 'split', 'transfer', 'standing order' } },
    },
}

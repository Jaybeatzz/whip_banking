Config = {
    CardProp = {
        model = 'banking_debit_card',
        bone = 28422,
        offset = { 0.042793, 0.012364, -0.033598 },
        rotation = { -10.8683, -177.8499, 23.6377 },
        animation = { dict = 'paper_1_rcm_alt1-8', clip = 'player_one_dual-8' }
    },
    AtmModels = { 'prop_atm_01', 'prop_atm_02', 'prop_atm_03', 'prop_fleeca_atm' },
    CardInsertion = {
        dict = 'amb@prop_human_atm@male@enter', clip = 'enter', duration = 1500,
        bone = 28422, offset = { 0.1, 0.03, -0.05 }, rotation = { 0.0, 0.0, 180.0 }
    },
    MaxTransaction = 100000,
    MaxAtmWithdrawal = 10000,
    InteractionDistance = 2.0,
    RoutingBucket = 0,
    Terminals = {
        legion_bank = {
            mode = 'bank', coords = vector3(149.91, -1040.46, 29.37),
            prompt = { coords = vector3(149.65, -1041.15, 30.10), heading = 340.0, findWall = true }
        }
    }
}

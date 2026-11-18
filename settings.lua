Whip.configPage({
    label = 'Banking',
    groups = {
        { label = 'Limits per transaction', settings = {
            { key = 'MaxTransaction', type = 'int', min = 1, max = 1000000000, label = 'Branch limit', unit = '$' },
            { key = 'MaxAtmWithdrawal', type = 'int', min = 1, max = 1000000000, label = 'ATM withdrawal limit', unit = '$' }
        } }
    }
})

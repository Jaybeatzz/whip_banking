Whip.configPage({
    label = 'Banking',
    groups = {
        { label = 'Bank', settings = {
            { key = 'BankName', type = 'string', maxLen = 32, label = 'Bank name' },
            { key = 'BankTagline', type = 'string', maxLen = 60, label = 'Tagline' },
            { key = 'BankColour', type = 'string', maxLen = 7, label = 'Bank colour (#rrggbb)' }
        } },
        { label = 'Limits per transaction', settings = {
            { key = 'MaxTransaction', type = 'int', min = 1, max = 1000000000, label = 'Branch limit', unit = '$' },
            { key = 'MaxAtmWithdrawal', type = 'int', min = 1, max = 1000000000, label = 'ATM withdrawal limit', unit = '$' }
        } },
        { label = 'Savings vaults', settings = {
            { key = 'Vaults.Max', type = 'int', min = 0, max = 5, label = 'Vaults per character' },
            { key = 'Vaults.InterestBasisPoints', type = 'int', min = 0, max = 1000, label = 'Interest per payout', unit = 'bp' },
            { key = 'Vaults.InterestEveryHours', type = 'int', min = 1, max = 720, label = 'Hours between payouts', unit = 'h' },
            { key = 'Vaults.InterestCap', type = 'int', min = 0, max = 1000000, label = 'Most per payout', unit = '$' },
            { key = 'Vaults.MinBalance', type = 'int', min = 0, max = 1000000, label = 'Balance needed for interest', unit = '$' },
            { key = 'Vaults.OnlineOnly', type = 'bool', label = 'Pay interest only while the owner is online' },
            { key = 'Vaults.MaxLockDays', type = 'int', min = 0, max = 365, label = 'Longest time lock', unit = 'days' }
        } },
        { label = 'Standing orders and requests', settings = {
            { key = 'Schedules.Max', type = 'int', min = 0, max = 50, label = 'Standing orders per character' },
            { key = 'Schedules.MaxFailures', type = 'int', min = 1, max = 20, label = 'Failures before it pauses' },
            { key = 'Requests.MaxPendingOut', type = 'int', min = 0, max = 100, label = 'Open requests per character' },
            { key = 'Requests.ExpireHours', type = 'int', min = 1, max = 720, label = 'Requests expire after', unit = 'h' },
            { key = 'Requests.MaxSplit', type = 'int', min = 1, max = 20, label = 'People in one split' }
        } },
        { label = 'Debit cards', settings = {
            { key = 'Cards.MaxDailyLimit', type = 'int', min = 1, max = 1000000000, label = 'Highest daily card limit', unit = '$' }
        } }
    }
})

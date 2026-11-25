# whip_banking

A full banking system for FiveM servers running the [WHIP framework](https://whipfx.net). Players can open bank accounts, move money, read statements, and carry PIN-protected debit cards, all through a themed NUI panel with controller support.

> **Note:** This is a community resource made for WHIP. It is **not** an official WHIP release.

![Debit card](web/assets/whip_debit_card.png)

## Features

- **Multiple accounts per character**: personal, savings, and shared accounts, each with its own account number (`WB-123456`).
- **Deposits, withdrawals and transfers** with per-transaction limits.
- **Two-step transfers**: the recipient is looked up and confirmed first, and the confirmation expires after 60 seconds.
- **Statements**: a recent-activity view on the overview, plus a paginated full transaction history.
- **Debit cards**: issue up to three cards per account, each with a four-digit PIN. Cards can be blocked, unblocked or revoked from the branch.
- **Physical card item** (`whip_debit_card`) that lives in the player's inventory, with a custom 3D prop and a hand animation when it is used.
- **Server-authoritative**: every client request goes through WHIP's `SecureCallback` / `SecureEvent` with rate limits and typed parameters. The server rechecks distance, session and account permissions on every action.
- **Safe money handling**: request IDs make retries idempotent, one transaction runs per character at a time, and failed steps are refunded or reversed automatically. Anything that can't be reversed is logged for staff reconciliation.
- **Every bank branch on the map**: all six Fleeca branches, Pacific Standard and Blaine County Savings in Paleto, each with a map blip.
- **Savings vaults**: real savings accounts with a goal, an optional time lock, and interest paid while the owner is in the city.
- **Standing orders**: money that moves by itself on a schedule (hourly to weekly), pausing itself after repeated failures.
- **Pay requests and bill splits**, phone to phone, with Pay or Decline from the notification.
- **Spending insights**: 30-day money in and out, a 14-day chart and a spending ring by category.
- **Card controls**: freeze, daily ATM limit, rename and cancel.
- **A real-bank look**: security-print linework in the bank's own colour, the account shown as a physical card (with a different finish for each account type), and activity grouped by day with category icons.
- **Controller and keyboard support** through WHIP's pad screen and on-screen keyboard.
- **Follows the active WHIP theme** automatically.

## Requirements

| Dependency | Notes |
|---|---|
| [`whip_core`](https://whipfx.net) | Version 1.0 or newer (`whip_requires '1.0'`) |
| [`oxmysql`](https://github.com/overextended/oxmysql) | Used for the card table |

## Installation

1. Copy the `whip_banking` folder into your server's `resources` directory.
2. Add it to `server.cfg` **after** WHIP and oxmysql:

   ```cfg
   ensure oxmysql
   ensure whip_core
   ensure whip_banking
   ```

3. Start the server. Its tables (`whip_banking_cards`, `whip_banking_vaults`, `whip_banking_schedules`, `whip_banking_requests`) are created automatically on first start, so there are no SQL files to import.
4. Run only one copy of the resource. Two copies both claim the `whip_banking:` callbacks, and the second one's prompts answer "That is no longer available".

## Usage

- Walk up to a configured bank branch and use the **Open Bank** prompt, or type `/bank` while standing at a branch.
- From the panel you can:
  - **Overview**: your account card, balance, 30-day in and out, activity, the month's spending, vaults and requests.
  - **Accounts**: every account as a card; open new ones.
  - **Cards**: issue debit cards, freeze them, set a daily ATM limit, rename or cancel them.
  - **Vaults**: savings jars with goals, locks and interest.
  - **Payments**: transfers, standing orders, and requests asked of you or by you.
  - **Insights**: where your money went.
  - **Statements**: the full statement, page by page.
- ATMs are left to whip_core's built-in ATM.
- With whip_phone, its Bank app gets vaults, standing orders, requests and bill splits, insights and card controls through this resource's `Phone` export (see *Exports*).
- Press `Esc` (or the Close button) to leave. The server ends the session as soon as you move away from the terminal, enter a vehicle, or log out.

### Debit cards

1. At a branch, choose an account and issue a card with a four-digit PIN. The card is added to your inventory.
2. Use the card item from your inventory to show it. The card is previewed and held in your hand.
3. Three wrong PIN attempts lock the card for five minutes. PINs are stored salted and hashed (SHA-256), never in plain text.

## Configuration

### `config.lua`

| Option | Description |
|---|---|
| `BankName`, `BankTagline`, `BankColour` | The bank's name, tagline and colour (`#rrggbb`) on every screen and card. |
| `Terminals` | Table of bank branches. Each has `mode`, `label`, `coords`, and an optional `prompt` (`coords`, `heading`, `findWall`) for the in-world interaction prompt. |
| `Blips` | Map blips for the branches: `enabled`, `sprite`, `colour`, `scale`, `label`. |
| `Vaults` | How many per character, interest per payout (basis points), hours between payouts, cap, minimum balance, online-only, longest lock. |
| `Schedules` | How many standing orders, the intervals players can pick, failures before pausing. |
| `Requests` | Open requests per character, expiry, people in one split. |
| `Cards` | The highest daily ATM limit a card can have. |
| `Categories` | Words that sort statement lines into spending categories for insights. |
| `InteractionDistance` | How close (in metres) a player must be to a terminal. Default `2.0`. |
| `MaxTransaction` | Default per-transaction limit at a branch. Default `100000`. |
| `MaxAtmWithdrawal` | Default per-transaction ATM withdrawal limit. Default `10000`. |
| `RoutingBucket` | Routing bucket players must be in to use banking. Default `0`. |
| `CardProp` | Model, bone, offset, rotation and animation for the held debit card. |

Adding a branch is a single entry:

```lua
Terminals = {
    legion_bank = {
        mode = 'bank', label = 'Legion Square',
        coords = vector3(149.91, -1040.46, 29.37),
        prompt = { coords = vector3(149.65, -1041.15, 30.10), heading = 340.0, findWall = true }
    },
    -- add more branches here
}
```

### In-game settings

`settings.lua` registers a **Banking** page in WHIP's admin panel (`/whip → Settings`). Admins can change the bank's name and colour, the limits, vault interest, and standing order and request limits there without editing files, and the changes survive updates.

## Project structure

```
whip_banking/
├── fxmanifest.lua
├── config.lua            # Terminals, limits, card prop
├── settings.lua          # In-game admin settings page
├── client/
│   └── main.lua          # Prompts, NUI bridge, card preview and animation
├── server/
│   ├── main.lua          # Accounts, transactions, sessions, callbacks
│   ├── cards.lua         # Debit card storage, PINs, limits, item registration
│   └── plus.lua          # Vaults, standing orders, requests, insights, card controls
├── stream/               # Debit card model, texture dictionary, ytyp
└── web/                  # NUI: index.html, app.js, style.css, assets
```

## Security notes

- The client never sends prices, balances or permissions. It only sends an account ID, an amount, and a request ID, and the server validates the rest.
- Amounts use WHIP's `amount` type, so negative and out-of-range values are refused rather than clamped.
- Banking sessions are tied to the character session and the player's position, and are cleared on logout and disconnect.
- Cash is moved with WHIP's `ChargePlayer` / `RefundPlayer` and `AddItem`, and every multi-step action has a rollback path.

## Exports (server)

| Export | Returns |
|---|---|
| `Phone(source, action, args)` | For whip_phone's Bank app. Reads the player from `source` itself and runs `overview`, `insights`, the vault, standing order, request and card actions. Result, or `false, why`. |
| `CanMoveOut(accountId)` | `true`, or `false, why` for a locked vault. Call it before moving money out of an account from another resource. |

## Notes

- Vault interest is new money. At the defaults one character can earn up to $500 a day per vault (3 vaults). Tune it in the settings page.
- Branch spots other than Legion Square were placed from known map coordinates and may need a small nudge on your map. Stand at the teller, use `/w` to copy coordinates, and update `Terminals`.

## Credits

- Author: **Jay**
- Built on [WHIP](https://whipfx.net) and [oxmysql](https://github.com/overextended/oxmysql).

## License

No license has been specified yet. Add a `LICENSE` file before publishing. If you ship WHIP files with this resource, note that WHIP itself is LGPL-3.0.

fx_version 'cerulean'
game 'gta5'
lua54 'yes'

author 'Jay'
description 'Banking - Made for Whip this is not an Official Resource'
version '2.1.0'

dependency 'whip_core'
whip_requires '1.0'

ui_page 'web/index.html'
nui_callback_strict_mode 'true'
files { 'web/index.html', 'web/app.js', 'web/style.css', 'web/assets/whip_debit_card.png' }
shared_scripts { '@whip_core/lib/satellite.lua', 'config.lua', 'settings.lua' }
client_script 'client/main.lua'
dependency 'oxmysql'
server_scripts { '@oxmysql/lib/MySQL.lua', 'server/cards.lua', 'server/plus.lua', 'server/main.lua' }

files { 'stream/banking_debit_card.ytyp' }
data_file 'DLC_ITYP_REQUEST' 'stream/banking_debit_card.ytyp'

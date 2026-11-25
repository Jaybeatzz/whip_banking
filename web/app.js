'use strict';
// whip_banking NUI: a bank branch (online-banking layout) and an ATM (a machine screen with soft keys).
// Everything is drawn from `state` by render(); every money move asks the server through client/main.lua.
// Text fields never take typing directly: they open whip's keyboard (editField), so the mouse and a controller
// behave the same. The controller arrives as { action: 'pad', cmd, down } from Whip.padScreen.

const $ = id => document.getElementById(id);
const app = $('app');
const resource = window.GetParentResourceName?.() || location.hostname.replace(/^cfx-nui-/, '');
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const fmtDay = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const fmtTime = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });
const fmtFull = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' });
const MOVE = { deposit: 'Deposit', withdraw: 'Withdraw', transfer: 'Transfer' };
const DONE = { deposit: 'Deposited', withdraw: 'Withdrew', transfer: 'Sent' };
const VIEWS = [
  ['overview', 'Overview', 'M4 11 12 4l8 7v9h-5v-6H9v6H4z'],
  ['accounts', 'Accounts', 'M3 9h18L12 4 3 9Zm2 11h14M7 12v5m5-5v5m5-5v5'],
  ['cards', 'Cards', 'M3 6h18v12H3zM3 10h18M7 15h4'],
  ['vaults', 'Vaults', 'M5 4h14v16H5zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm0 0V7m0 8v2'],
  ['payments', 'Payments', 'M4 8h16m-4-4 4 4-4 4m4 4H4m4-4-4 4 4 4'],
  ['insights', 'Insights', 'M4 20V10m6 10V4m6 16v-7m4 7H2'],
  ['statement', 'Statements', 'M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6'],
];
const VAULT_COLOURS = ['blue', 'green', 'gold', 'rose', 'violet', 'teal'];
const EVERY = { 1: 'Every hour', 6: 'Every 6 hours', 24: 'Every day', 72: 'Every 3 days', 168: 'Every week' };

let state = null;          // the open session, null when closed
let latestGeneration = 0;
let pad = false;           // a controller is driving
let editing = false;       // whip's keyboard is up
let previewSequence = null;

// ---------------------------------------------------------------- utils
const h = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => usd.format(Math.round(+n || 0));
const signed = n => (n > 0 ? '+' : n < 0 ? '−' : '') + usd.format(Math.abs(Math.round(n)));
const icon = d => `<svg aria-hidden="true" viewBox="0 0 24 24"><path d="${d}"/></svg>`;
const whole = v => (/^\d+$/.test(String(v ?? '').trim()) ? Number(String(v).trim()) : 0);
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const when = t => { const d = new Date(typeof t === 'number' ? t * 1000 : t); return Number.isNaN(d.getTime()) ? '' : d; };
const relDay = t => { const d = when(t); if (!d) return ''; const days = Math.round((d - Date.now()) / 86400000);
  if (Math.abs(d - Date.now()) < 3600000) return 'within the hour';
  if (days === 0) return 'today, ' + fmtTime.format(d); if (days === 1) return 'tomorrow'; if (days === -1) return 'yesterday';
  return fmtDay.format(d); };

async function call(name, data = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  let res;
  try {
    res = await (await fetch(`https://${resource}/${name}`, { method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })).json();
  } catch {
    throw new Error(MOVE[name] ? 'No confirmation came back. Check your statement before trying again.' : 'The bank did not answer. Try again.');
  } finally { clearTimeout(timer); }
  if (!res.ok) throw new Error(res.error?.message || 'That could not be completed.');
  return res.data;
}
const plus = (action, args = {}) => call('plus', { action, args });

// ---------------------------------------------------------------- derived
const snap = () => state.snapshot;
const atm = () => snap().mode === 'atm';
const account = () => snap().accounts.find(a => a.id === snap().selectedAccountId);
const accountById = id => snap().accounts.find(a => a.id === String(id));
const vaultIds = () => new Set((snap().plus?.vaults || []).map(v => String(v.id)));
const everyday = () => snap().accounts.filter(a => !vaultIds().has(a.id));
const cardsFor = id => (snap().cards || []).filter(c => String(c.accountId) === String(id));
const typeName = a => ({ personal: 'Personal', savings: vaultIds().has(a.id) ? 'Vault' : 'Savings', shared: 'Shared', business: 'Business' }[a.type] || 'Account');

function notice(text = '', kind = '') { state.notice = text ? { text, kind } : null; render(); }

// ---------------------------------------------------------------- busy wrapper
async function run(work, { quiet = false } = {}) {
  const current = state;
  if (!current || current.busy) return;
  current.busy = true;
  if (!quiet) render();
  try { await work(current); }
  catch (e) { if (state === current) { current.notice = { text: e.message, kind: 'error' }; } }
  finally { if (state === current) { current.busy = false; render(); } }
}

async function reload(current, accountId = current.snapshot.selectedAccountId) {
  const s = await call('getBankSnapshot', { accountId: accountId || 0 });
  if (state !== current) return;
  normalise(s);
  current.snapshot = s;
  current.statement = null;
  if (current.view === 'insights' || current.view === 'overview') setTimeout(loadInsights, 0);
}

function normalise(s) {
  s.accounts = Array.isArray(s.accounts) ? s.accounts : [];
  s.recent = Array.isArray(s.recent) ? s.recent : [];
  s.cards = Array.isArray(s.cards) ? s.cards : [];
  if (s.plus) for (const k of ['vaults', 'schedules']) s.plus[k] = Array.isArray(s.plus[k]) ? s.plus[k] : [];
  if (s.plus && !s.plus.requests) s.plus.requests = { incoming: [], outgoing: [] };
}

// ---------------------------------------------------------------- fields (whip keyboard)
async function editField(field, key, extra = {}) {
  const current = state;
  if (!current || editing || current.busy) return;
  editing = true;
  try {
    const r = await call('editField', { field, value: String(current.form?.values?.[key] ?? ''), action: current.form?.action,
      accountName: account()?.name, ...extra });
    if (state === current && r && !r.cancelled && current.form) { current.form.values[key] = r.value ?? ''; current.form.error = null; }
  } catch (e) { if (state === current && current.form) current.form.error = e.message; }
  finally { editing = false; if (state === current) render(); }
}

// ---------------------------------------------------------------- forms (sheets)
function openForm(kind, values = {}, extra = {}) {
  state.form = { kind, values, step: 'edit', error: null, request: uuid(), ...extra };
  state.notice = null;
  render();
  focusFirst('.sheet');
}
function closeForm() { state.form = null; render(); focusKey(state.returnKey); }

const FORMS = {
  move: {
    title: f => MOVE[f.action],
    body(f) {
      const a = account(), limit = snap().limit;
      const avail = f.action === 'deposit' ? snap().cash : a?.balance;
      if (f.step === 'review') return review(money(f.values.amount), f.reviewNote, `Confirm ${MOVE[f.action].toLowerCase()}`);
      return (f.action === 'transfer' ? field('recipient', 'number', 'To account', 'WB-123456') : '') +
        field('amount', 'amount', 'Amount', '$0', `${f.action === 'deposit' ? 'Cash in your wallet' : 'Available'}: ${money(avail)} · limit ${money(limit)}`) +
        quick('amount', [100, 500, 1000, 5000].filter(v => v <= Math.min(avail || 0, limit)), avail) +
        actions(`Review`, 'review');
    },
    async submit(f, current) {
      const a = account(), amount = whole(f.values.amount);
      if (f.step === 'edit') {
        const avail = f.action === 'deposit' ? snap().cash : a.balance;
        if (amount < 1 || amount > snap().limit) throw new Error(`Enter a whole amount from $1 to ${money(snap().limit)}.`);
        if (amount > avail) throw new Error(f.action === 'deposit' ? 'You do not have that much cash.' : 'The balance is too low.');
        if (f.action === 'transfer') {
          const number = String(f.values.number || '').trim().toUpperCase();
          if (!/^WB-\d{6}$/.test(number)) throw new Error('Enter an account number like WB-123456.');
          const r = await call('resolveRecipient', { accountId: a.id, accountNumber: number, amount });
          f.token = r.token;
          f.reviewNote = `From ${a.name} to ${r.name} (${r.maskedNumber}).`;
        } else f.reviewNote = f.action === 'deposit' ? `Cash into ${a.name}.` : `Cash out of ${a.name}.`;
        f.step = 'review';
        return;
      }
      await call(f.action, { accountId: a.id, amount, requestId: f.request, recipientToken: f.token });
      await finish(current, `${DONE[f.action]} ${money(amount)}.`);
    },
  },
  openAccount: {
    title: () => 'Open an account',
    body: f => field('name', 'account-name', 'Account name', 'Rainy day') +
      choice('kind', [['savings', 'Savings'], ['shared', 'Shared']], f.values.kind || 'savings',
        f.values.kind === 'shared' ? 'Yours, and you can share it with others from your phone.' : 'Just yours. Move money in and out with transfers.') +
      actions('Open account', 'submit'),
    async submit(f, current) {
      const label = String(f.values.name || '').trim();
      if (!label) throw new Error('Give the account a name.');
      const r = await call('createAccount', { label, kind: f.values.kind || 'savings' });
      await finish(current, `Opened ${label}.`, r.accountId);
    },
  },
  issueCard: {
    title: () => 'New debit card',
    body: f => `<p class="sheet-note">The card goes into your inventory. Choose a four-digit PIN you will type at ATMs.</p>` +
      pinPad(f.values.pin || '', f.values.confirming ? 'Type it again' : 'Choose a PIN') + actions(f.values.confirming ? 'Issue card' : 'Next', 'submit'),
    async submit(f, current) {
      const pin = f.values.pin || '';
      if (!/^\d{4}$/.test(pin)) throw new Error('Enter four digits.');
      if (!f.values.confirming) { f.values = { first: pin, pin: '', confirming: true }; return; }
      if (pin !== f.values.first) { f.values = { pin: '' }; throw new Error('The PINs did not match. Choose it again.'); }
      await call('issueCard', { accountId: account().id, pin, requestId: f.request });
      await finish(current, 'Debit card issued to your inventory.');
    },
  },
  cardLimit: {
    title: () => 'Daily ATM limit',
    body: f => field('limit', 'card-limit', 'Limit per day', '0 for no limit', `Up to ${money(snap().plus?.limits?.cardLimit || 0)}. Each ATM withdrawal also has the machine's own limit.`) +
      actions('Save limit', 'submit'),
    async submit(f, current) {
      await plus('cardControl', { account: f.account, card: f.card, action: 'limit', value: whole(f.values.limit) });
      await finish(current, 'Card limit saved.');
    },
  },
  cardName: {
    title: () => 'Name this card',
    body: () => field('name', 'card-name', 'Card name', 'Everyday') + actions('Save name', 'submit'),
    async submit(f, current) {
      await plus('cardControl', { account: f.account, card: f.card, action: 'rename', value: String(f.values.name || '') });
      await finish(current, 'Card renamed.');
    },
  },
  vaultNew: {
    title: () => 'New vault',
    body: f => field('name', 'vault-name', 'Name', 'New car') +
      field('goal', 'vault-goal', 'Goal', 'Optional', 'We tell you when the vault reaches it.') +
      field('lock', 'vault-lock', 'Lock for', '0 days', `While locked nothing can leave the vault. Up to ${snap().plus?.limits?.lockDays || 0} days, and a lock can't be shortened.`) +
      colours(f.values.colour || 'blue') + actions('Open vault', 'submit'),
    async submit(f, current) {
      const name = String(f.values.name || '').trim();
      if (!name) throw new Error('Give the vault a name.');
      await plus('vaultCreate', { name, goal: whole(f.values.goal), lockDays: whole(f.values.lock), colour: f.values.colour || 'blue' });
      await finish(current, `${name} is open. Move money in to start saving.`);
    },
  },
  vaultEdit: {
    title: f => vaultOf(f.vault)?.name || 'Vault',
    body: f => field('goal', 'vault-goal', 'Goal', 'No goal') +
      field('lock', 'vault-lock', 'Lock for', 'Keep as is', 'Extends the lock from now. It can never be shortened.') +
      colours(f.values.colour || vaultOf(f.vault)?.colour) + actions('Save changes', 'submit'),
    async submit(f, current) {
      const args = { id: f.vault, goal: whole(f.values.goal), colour: f.values.colour };
      if (String(f.values.lock || '').trim()) args.lockDays = whole(f.values.lock);
      await plus('vaultEdit', args);
      await finish(current, 'Vault updated.');
    },
  },
  vaultMove: {
    title: f => (f.direction === 'in' ? 'Add to ' : 'Take from ') + (vaultOf(f.vault)?.name || 'vault'),
    body: f => accountChoice('account', f.direction === 'in' ? 'From' : 'To', f.values.account) +
      field('amount', 'vault-amount', 'Amount', '$0') +
      quick('amount', [100, 500, 1000], f.direction === 'in' ? accountById(f.values.account)?.balance : vaultOf(f.vault)?.balance) +
      actions(f.direction === 'in' ? 'Add money' : 'Take money out', 'submit'),
    async submit(f, current) {
      const amount = whole(f.values.amount);
      if (!amount) throw new Error('Enter an amount.');
      if (!f.values.account) throw new Error('Pick an account.');
      await plus('vaultMove', { id: f.vault, account: +f.values.account, amount, direction: f.direction });
      await finish(current, `${f.direction === 'in' ? 'Added' : 'Took out'} ${money(amount)}.`);
    },
  },
  vaultClose: {
    title: f => 'Close ' + (vaultOf(f.vault)?.name || 'vault'),
    body: f => `<p class="sheet-note">${money(vaultOf(f.vault)?.balance)} moves to the account you pick, then the vault closes for good.</p>` +
      accountChoice('account', 'Move the money to', f.values.account) + actions('Close vault', 'submit', 'danger'),
    async submit(f, current) {
      await plus('vaultClose', { id: f.vault, account: +f.values.account || 0 });
      await finish(current, 'Vault closed.');
    },
  },
  schedule: {
    title: () => 'New standing order',
    body: f => {
      const to = f.values.toKind || 'mine';
      const intervals = snap().plus?.intervals || [24];
      return `<p class="sheet-note">From ${h(account()?.name)}. It pays by itself, even while you're away.</p>` +
        choice('toKind', [['mine', 'My account'], ['other', 'Someone else']], to) +
        (to === 'mine' ? accountChoice('to', 'Pay into', f.values.to, account()?.id, true) : field('number', 'so-number', 'Account number', 'WB-123456')) +
        field('amount', 'so-amount', 'Amount each time', '$0') +
        choice('every', intervals.map(v => [String(v), EVERY[v] || `Every ${v} hours`]), String(f.values.every || intervals[Math.min(2, intervals.length - 1)])) +
        field('label', 'so-label', 'What for', 'Rent, allowance…') +
        field('runs', 'so-runs', 'Stop after', 'Until I stop it', 'Number of payments.') +
        actions('Set up standing order', 'submit');
    },
    async submit(f, current) {
      const intervals = snap().plus?.intervals || [24];
      const args = { from: +account().id, amount: whole(f.values.amount), label: String(f.values.label || ''),
        everyHours: +(f.values.every || intervals[Math.min(2, intervals.length - 1)]) };
      if (!args.amount) throw new Error('Enter an amount.');
      if ((f.values.toKind || 'mine') === 'mine') { if (!f.values.to) throw new Error('Pick the account to pay into.'); args.to = +f.values.to; }
      else args.number = String(f.values.number || '').trim();
      if (String(f.values.runs || '').trim()) args.runs = whole(f.values.runs);
      await plus('scheduleCreate', args);
      await finish(current, 'Standing order set up.');
    },
  },
  payRequest: {
    title: f => `Pay ${money(f.amount)}`,
    body: f => `<p class="sheet-note">${h(f.name)} asked${f.note ? ` for ${h(f.note)}` : ''}.</p>` +
      accountChoice('account', 'Pay from', f.values.account) + actions(`Pay ${money(f.amount)}`, 'submit'),
    async submit(f, current) {
      await plus('requestPay', { id: f.id, account: +f.values.account || 0 });
      await finish(current, `Paid ${money(f.amount)} to ${f.name}.`);
    },
  },
  confirm: {
    title: f => f.heading,
    body: f => `<p class="sheet-note">${h(f.text)}</p>` + actions(f.yes, 'submit', f.danger ? 'danger' : ''),
    async submit(f, current) { await f.run(); await finish(current, f.done); },
  },
};

const vaultOf = id => (snap().plus?.vaults || []).find(v => String(v.id) === String(id));

async function finish(current, message, accountId) {
  current.form = null;
  current.notice = { text: message, kind: 'success' };
  try { await reload(current, accountId); } catch { current.notice = { text: message + ' Refresh to see the new balance.', kind: 'success' }; }
}

async function submitForm() {
  const f = state?.form;
  if (!f) return;
  await run(async current => {
    f.error = null;
    try { await FORMS[f.kind].submit(f, current); }
    catch (e) { if (state === current && current.form === f) f.error = e.message; else throw e; }
  });
  if (state?.form === f) focusFirst('.sheet [data-primary]') || focusFirst('.sheet');
}

// form pieces
function field(key, editor, label, placeholder, help) {
  const v = state.form.values[key];
  const shown = v === undefined || v === '' ? `<span class="ph">${h(placeholder)}</span>` :
    (editor.includes('amount') || editor === 'vault-goal' || editor === 'card-limit' ? h(money(whole(v))) : h(v));
  return `<label class="fld"><span class="fld-l">${h(label)}</span>` +
    `<button type="button" class="fld-v" data-k="f-${key}" data-edit="${editor}" data-key="${key}">${shown}</button>` +
    (help ? `<small>${h(help)}</small>` : '') + `</label>`;
}
function quick(key, values, all) {
  const chips = values.map(v => `<button type="button" class="chip" data-k="q-${v}" data-set="${key}" data-v="${v}">${money(v)}</button>`);
  if (all > 0) chips.push(`<button type="button" class="chip" data-k="q-all" data-set="${key}" data-v="${Math.floor(all)}">All ${money(all)}</button>`);
  return chips.length ? `<div class="chips">${chips.join('')}</div>` : '';
}
function choice(key, options, value, help) {
  return `<div class="seg" role="group">${options.map(([v, label]) =>
    `<button type="button" data-k="c-${key}-${v}" data-set="${key}" data-v="${h(v)}" aria-pressed="${String(v) === String(value)}">${h(label)}</button>`).join('')}</div>` +
    (help ? `<small class="seg-help">${h(help)}</small>` : '');
}
function accountChoice(key, label, value, exclude, includeVaults) {
  const f = state.form;
  const list = (includeVaults ? snap().accounts : everyday()).filter(a => a.id !== String(exclude) && a.id !== String(f.vault) && !a.frozen);
  if (!value && list[0]) { f.values[key] = list[0].id; value = list[0].id; }
  return `<div class="fld"><span class="fld-l">${h(label)}</span><div class="pick">${list.map(a =>
    `<button type="button" data-k="a-${key}-${a.id}" data-set="${key}" data-v="${a.id}" aria-pressed="${a.id === String(value)}">` +
    `<span>${h(a.name)}</span><b>${money(a.balance)}</b></button>`).join('') || '<p class="muted">No account to use.</p>'}</div></div>`;
}
function colours(value) {
  return `<div class="fld"><span class="fld-l">Colour</span><div class="swatches">${VAULT_COLOURS.map(c =>
    `<button type="button" class="sw v-${c}" data-k="sw-${c}" data-set="colour" data-v="${c}" aria-pressed="${c === value}" aria-label="${c}"></button>`).join('')}</div></div>`;
}
function actions(label, act, tone = '') {
  return `<div class="sheet-actions"><button type="button" data-k="cancel" data-act="closeForm">Cancel</button>` +
    `<button type="button" class="primary ${tone}" data-primary data-k="go" data-act="${act === 'review' ? 'submit' : 'submit'}">${h(label)}</button></div>`;
}
function review(total, note, label) {
  return `<div class="review"><span>You're about to move</span><strong>${h(total)}</strong><p>${h(note)}</p></div>` +
    `<div class="sheet-actions"><button type="button" data-k="back" data-act="formBack">Change</button>` +
    `<button type="button" class="primary" data-primary data-k="go" data-act="submit">${h(label)}</button></div>`;
}
function pinPad(value, label) {
  const dots = [0, 1, 2, 3].map(i => `<i class="${i < value.length ? 'on' : ''}"></i>`).join('');
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'del'].map(k =>
    `<button type="button" data-k="pin-${k}" data-pin="${k}" class="${k.length > 1 ? 'fn' : ''}">${k === 'del' ? '⌫' : k === 'clear' ? 'Clear' : k}</button>`).join('');
  return `<div class="pin"><span class="pin-l">${h(label)}</span><div class="pin-dots" aria-label="${value.length} of 4 digits">${dots}</div><div class="pin-keys">${keys}</div></div>`;
}

// ---------------------------------------------------------------- branch views
// THE LOOK: security printing. Real banks print cheques, notes and cards with guilloche (interlaced engraved
// rosettes), microprint and serial numbers so they can't be copied; here that linework, drawn in the bank's own
// colour (Config.BankColour), is the bank's signature. Everything around it stays quiet: WHIP's surfaces and type.

const guillocheCache = new Map();
/** Interlaced rosettes and wave bands, as one SVG path set (cached by size and seed). */
function guilloche(w, h, seed = 1) {
  const key = `${w}x${h}:${seed}`;
  if (guillocheCache.has(key)) return guillocheCache.get(key);
  const paths = [];
  const rosette = (cx, cy, R, r, d, turns, steps) => {
    let p = '';
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * Math.PI * 2 * turns;
      const x = cx + (R - r) * Math.cos(t) + d * Math.cos(((R - r) / r) * t);
      const y = cy + (R - r) * Math.sin(t) - d * Math.sin(((R - r) / r) * t);
      p += (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
    }
    return p;
  };
  const big = Math.min(w, h);
  paths.push(`<path class="g1" d="${rosette(w * 0.82, h * 0.5, big * 0.62, big * (0.11 + seed * 0.004), big * 0.2, 11, 1400)}"/>`);
  paths.push(`<path class="g2" d="${rosette(w * 0.82, h * 0.5, big * 0.44, big * 0.07, big * 0.15, 7, 900)}"/>`);
  for (let k = 0; k < 9; k++) {
    let p = '';
    for (let x = 0; x <= w; x += 6) {
      const y = h * (0.12 + k * 0.1) + Math.sin(x / (18 + k * 2) + k + seed) * (5 + k) + Math.sin(x / 61) * 6;
      p += (x ? 'L' : 'M') + x + ' ' + y.toFixed(1);
    }
    paths.push(`<path class="g3" d="${p}"/>`);
  }
  const svg = `<svg class="guilloche" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid slice" aria-hidden="true">${paths.join('')}</svg>`;
  guillocheCache.set(key, svg);
  return svg;
}

/** A line of microprint, as on a note's border: the bank's name, repeated. */
const microprint = () => `<div class="micro" aria-hidden="true">${h(((snap().bank?.name || 'Bank') + ' ').toUpperCase().repeat(24))}</div>`;

/** WB-178928 → WB 178 928, as a card or cheque prints it */
const serial = n => String(n || '').replace(/^WB-(\d{3})(\d{3})$/, 'WB $1 $2');

// What a statement line was, from its text: the icon and colour of the circle beside it.
const CATS = [
  ['income', 'In', 'M12 5v14m0 0-6-6m6 6 6-6'],
  ['cash', 'Cash', 'M3 7h18v10H3zM12 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z', ['cash', 'atm', 'withdraw']],
  ['food', 'Food & drink', 'M7 3v8m-2-8v4a2 2 0 0 0 4 0V3M7 11v10m10-18c-2 0-3 2-3 5s1 4 3 4v9', ['food', 'cafe', 'coffee', 'burger', 'pizza', 'restaurant', 'bar', 'drink', 'diner', 'taco']],
  ['vehicles', 'Vehicles', 'M5 16h14M6 16l1.5-5h9L18 16M7 19a1 1 0 1 0 0-2M17 19a1 1 0 1 0 0-2', ['fuel', 'gas', 'garage', 'vehicle', 'car', 'repair', 'tuning', 'impound', 'park', 'dealership']],
  ['housing', 'Housing', 'M4 11 12 4l8 7v9H4z', ['rent', 'property', 'house', 'home', 'apartment', 'mortgage']],
  ['bills', 'Bills', 'M7 3h10v18l-2.5-1.5L12 21l-2.5-1.5L7 21zM10 8h4m-4 4h4', ['fine', 'bill', 'tax', 'fee', 'invoice', 'ticket', 'phone']],
  ['shopping', 'Shopping', 'M5 8h14l-1 12H6zM9 8a3 3 0 0 1 6 0', ['shop', 'store', 'purchase', 'market', 'clothing', 'gun', 'ammu', 'sale']],
  ['savings', 'Savings', 'M5 4h14v16H5zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z', ['vault', 'savings', 'interest']],
  ['people', 'People', 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm-6 9a6 6 0 0 1 12 0m2-9a3 3 0 1 0 0-6m4 15a6 6 0 0 0-4-5.6', ['request', 'split', 'transfer', 'standing order', 'from', 'to ']],
];
function catOf(t) {
  const text = String(t.description || '').toLowerCase();
  if (t.amount > 0 && !/vault|interest/.test(text)) return CATS[0];
  return CATS.slice(1).find(c => c[3].some(w => text.includes(w))) || ['other', 'Other', 'M12 8v4m0 4h.01M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z'];
}

/** The statement, grouped by day like a printed statement: Today, Yesterday, then dates. */
function ledgerRows(items, running) {
  if (!items.length) return `<p class="empty">Nothing has moved on this account yet.</p>`;
  const groups = [];
  const today = new Date(); today.setHours(0, 0, 0, 0);
  for (const t of items) {
    const d = when(t.date);
    let label = '';
    if (d) {
      const day = new Date(d); day.setHours(0, 0, 0, 0);
      const diff = Math.round((today - day) / 86400000);
      label = diff === 0 ? 'Today' : diff === 1 ? 'Yesterday' : fmtDay.format(d);
    }
    if (!groups.length || groups[groups.length - 1].label !== label) groups.push({ label, items: [] });
    groups[groups.length - 1].items.push(t);
  }
  return `<div class="feed${running ? ' running' : ''}">${groups.map(g => `<section><h3>${h(g.label)}</h3><ol>${g.items.map(t => {
    const c = catOf(t), d = when(t.date);
    return `<li><span class="cat c-${c[0]}">${icon(c[2])}</span>` +
      `<span class="what"><b>${h(t.description)}</b><small>${h(c[1])}${d ? ' · ' + fmtTime.format(d) : ''}</small></span>` +
      `<span class="amt ${t.amount > 0 ? 'in' : ''}">${signed(t.amount)}</span>` +
      (running ? `<span class="run">${t.balance != null ? money(t.balance) : ''}</span>` : '') + `</li>`;
  }).join('')}</ol></section>`).join('')}</div>`;
}

function trendPath(points, w = 600, ht = 60) {
  if (points.length < 2) return '';
  const hi = Math.max(...points), lo = Math.min(...points);
  return points.map((v, i) => `${(i / (points.length - 1) * w).toFixed(1)} ${(hi === lo ? ht / 2 : ht - 4 - (v - lo) / (hi - lo) * (ht - 8)).toFixed(1)}`).join(' L');
}

/** The account as the card in your wallet: bank colour, security print, chip, serial, holder. */
function accountCard(a, small = false) {
  return `<div class="acard t-${typeName(a).toLowerCase()}${small ? ' sm' : ''}${a.frozen ? ' frozen' : ''}">${guilloche(small ? 220 : 430, small ? 138 : 270, (+a.id % 7) + 1)}
    <span class="ac-top"><b>${h(snap().bank?.name || 'Bank')}</b><i>${h(typeName(a))}</i></span>
    ${small ? '' : '<span class="ac-chip"></span>'}
    <span class="ac-num">${h(serial(a.number))}</span>
    <span class="ac-foot"><span>${h(a.name)}</span>${small ? '' : `<span>${h(snap().characterName || '')}</span>`}</span>
    ${a.frozen ? '<em class="ac-flag">Frozen</em>' : ''}</div>`;
}

function bigBalance(n) {
  const text = money(n);
  const size = Math.max(34, Math.min(66, 66 - Math.max(0, text.length - 9) * 4.2));
  return `<strong class="balance" style="font-size:${size.toFixed(0)}px">${text}</strong>`;
}

function hero() {
  const a = account(), s = snap();
  if (!a) return `<section class="hero"><p class="empty">You have no account to use here.</p></section>`;
  const i = state.insights && state.insights.accountId === +a.id ? state.insights : null;
  const points = s.recent.slice().reverse().map(t => t.balance).filter(Number.isFinite);
  const line = trendPath(points, 300, 54);
  const can = x => !state.busy && !a.frozen && (x === 'deposit' ? a.canDeposit !== false : a.canWithdraw !== false);
  const act = (x, label, d, extra = '') => `<button type="button" class="round" data-k="mv-${x}" ${extra || `data-act="move" data-v="${x}" ${can(x) ? '' : 'disabled'}`}><i>${icon(d)}</i><span>${label}</span></button>`;
  const others = s.accounts.filter(x => x.id !== a.id);
  return `<section class="hero">
    <div class="hero-card">${accountCard(a)}
      ${others.length ? `<div class="wallet-stack" role="tablist" aria-label="Your accounts">${s.accounts.map(x =>
        `<button type="button" role="tab" data-k="tab-${x.id}" data-act="selectAccount" data-id="${x.id}" aria-selected="${x.id === a.id}"><i class="dot"></i>${h(x.name)}</button>`).join('')}</div>` : ''}
    </div>
    <div class="hero-main">
      <span class="hero-l">Available balance</span>
      ${bigBalance(a.balance)}
      <div class="hero-stats">
        <span><small>In, 30 days</small><b class="in">${i ? money(i.monthIn) : '—'}</b></span>
        <span><small>Out, 30 days</small><b>${i ? money(i.monthOut) : '—'}</b></span>
        <span class="spark">${line ? `<svg viewBox="0 0 300 54" preserveAspectRatio="none" aria-hidden="true"><path class="sp-a" d="M${line} V54 H0Z"/><path class="sp-l" d="M${line}"/></svg>` : ''}<small>Recent balance</small></span>
      </div>
      <div class="rounds">
        ${act('deposit', 'Deposit', 'M12 19V5m0 0-6 6m6-6 6 6')}
        ${act('withdraw', 'Withdraw', 'M12 5v14m0 0-6-6m6 6 6-6')}
        ${act('transfer', 'Transfer', 'M4 8h16m-4-4 4 4-4 4m4 4H4m4-4-4 4 4 4')}
        ${act('statement', 'Statement', 'M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6', 'data-act="view" data-v="statement"')}
      </div>
    </div>
    ${microprint()}
  </section>`;
}

/** A donut of where the money went: the month's spending by category, the total in the middle. */
function donut(i, size = 150) {
  const cats = (i?.categories || []).slice(0, 6);
  const r = size / 2 - 12, C = 2 * Math.PI * r;
  let off = 0;
  const arcs = cats.map((c, n) => {
    const len = Math.max(0, c.share * C - 3);
    const seg = `<circle class="d-${n}" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-dasharray="${len.toFixed(1)} ${(C - len).toFixed(1)}" stroke-dashoffset="${(-off).toFixed(1)}"/>`;
    off += c.share * C;
    return seg;
  }).join('');
  return `<div class="donut"><svg viewBox="0 0 ${size} ${size}" style="width:${size}px;height:${size}px" aria-hidden="true">` +
    `<circle class="d-track" cx="${size / 2}" cy="${size / 2}" r="${r}"/>${arcs}</svg>` +
    `<span><small>Spent</small><b>${money(i?.monthOut || 0)}</b></span></div>` +
    `<ol class="d-legend">${cats.map((c, n) => `<li><i class="d-${n}"></i><span>${h(c.label)}</span><b>${money(c.total)}</b></li>`).join('')}</ol>`;
}

/** A savings jar, filled to its goal. */
function jar(v, w = 74) {
  const p = Math.max(0.04, Math.min(1, v.goal ? v.progress || 0 : 0.35));
  const top = 22 + (1 - p) * 64;
  return `<svg class="jar v-${v.colour}" viewBox="0 0 80 100" style="width:${w}px;height:${Math.round(w * 1.25)}px" aria-hidden="true">
    <defs><clipPath id="jar-${v.id}"><path d="M18 18h44v6c8 4 10 10 10 18v42c0 6-4 10-10 10H18c-6 0-10-4-10-10V42c0-8 2-14 10-18z"/></clipPath></defs>
    <g clip-path="url(#jar-${v.id})"><rect class="jar-fill" x="0" y="${top.toFixed(1)}" width="80" height="100"/>
    <path class="jar-wave" d="M0 ${top.toFixed(1)} q10 -4 20 0 t20 0 t20 0 t20 0 V100 H0z"/></g>
    <path class="jar-glass" d="M18 18h44v6c8 4 10 10 10 18v42c0 6-4 10-10 10H18c-6 0-10-4-10-10V42c0-8 2-14 10-18z"/>
    <rect class="jar-lid" x="15" y="8" width="50" height="11" rx="3"/></svg>`;
}

function viewOverview() {
  const s = snap(), p = s.plus || {}, inc = p.requests?.incoming || [];
  const a = account(), i = state.insights && a && state.insights.accountId === +a.id ? state.insights : null;
  const next = (p.schedules || []).filter(x => x.status === 'active').sort((x, y) => x.nextRunAt - y.nextRunAt)[0];
  const vaults = p.vaults || [];
  return hero() + `<div class="cols">
    <section class="panel"><header class="ph-row"><h2>Activity</h2><button type="button" class="link" data-k="ov-st" data-act="view" data-v="statement">Full statement</button></header>
      ${ledgerRows(s.recent.slice(0, 7))}</section>
    <div class="stack">
      ${inc.length ? `<section class="panel attn"><h2>${inc.length === 1 ? 'Someone asked you for money' : `${inc.length} people asked you for money`}</h2>${inc.slice(0, 3).map(requestRow).join('')}</section>` : ''}
      <section class="panel"><header class="ph-row"><h2>This month</h2><button type="button" class="link" data-k="ov-i" data-act="view" data-v="insights">Insights</button></header>
        ${i ? (i.categories.length ? donut(i, 128) : '<p class="muted">No spending in the last 30 days.</p>') : '<p class="muted">Reading your statement…</p>'}</section>
      <section class="panel"><header class="ph-row"><h2>Vaults</h2><button type="button" class="link" data-k="ov-v" data-act="view" data-v="vaults">${vaults.length ? 'All vaults' : 'Start saving'}</button></header>
        ${vaults.length ? `<div class="jars">${vaults.slice(0, 3).map(v => `<div class="jar-mini">${jar(v, 46)}<span><b>${money(v.balance)}</b><small>${h(v.name)}</small></span></div>`).join('')}</div>`
          : '<p class="muted">Put money aside in a jar with a goal and a time lock, and earn interest on it.</p>'}</section>
      ${next ? `<section class="panel"><header class="ph-row"><h2>Next standing order</h2><button type="button" class="link" data-k="ov-p" data-act="view" data-v="payments">Payments</button></header>
        <p class="next-so"><b>${money(next.amount)}</b> to ${h(next.toLabel)}<br><span class="muted">${h(next.label || EVERY[next.everyHours] || '')}, next ${h(relDay(next.nextRunAt))}</span></p></section>` : ''}
    </div></div>`;
}

function viewAccounts() {
  const s = snap();
  return `<header class="v-head"><h1>Accounts</h1><button type="button" class="primary" data-k="acc-new" data-act="openAccount">Open an account</button></header>
    <div class="acct-grid">${s.accounts.map(a => `<button type="button" class="acct-tile ${a.id === s.selectedAccountId ? 'sel' : ''}" data-k="acc-${a.id}" data-act="selectAccount" data-id="${a.id}">
      ${accountCard(a, true)}<span class="at-meta"><b>${money(a.balance)}</b><small>${h(typeName(a))}${a.role && a.role !== 'owner' ? ` · ${h(a.role)} access` : ''}</small></span></button>`).join('')}</div>
    <p class="muted foot">Share an account with someone, or close one, from the Bank app on your phone.</p>`;
}

function cardArt(c, a) {
  return `<div class="dcard ${c.status === 'blocked' ? 'frozen' : ''}">${guilloche(340, 214, 3)}<span class="dc-bank">${h(snap().bank?.name || 'Bank')}</span>
    <span class="dc-chip"></span><span class="dc-num">•••• •••• •••• ${h(c.lastFour)}</span>
    <span class="dc-name">${h(c.nickname || a?.name || 'Debit')}</span><span class="dc-kind">Debit</span>${c.status === 'blocked' ? '<span class="dc-flag">Frozen</span>' : ''}</div>`;
}

function viewCards() {
  const a = account();
  if (!a) return `<header class="v-head"><h1>Cards</h1></header><p class="empty">Pick an account first.</p>`;
  const cards = cardsFor(a.id);
  const canIssue = a.canWithdraw !== false && !a.frozen && cards.length < 3;
  return `<header class="v-head"><h1>Cards for ${h(a.name)}</h1>${canIssue ? '<button type="button" class="primary" data-k="card-new" data-act="issueCard">New debit card</button>' : ''}</header>
    ${snap().cardError ? `<p class="notice error">${h(snap().cardError)}</p>` : ''}
    ${cards.length ? `<div class="card-grid">${cards.map(c => {
      const pct = c.dailyLimit ? Math.min(100, Math.round(c.spentToday / c.dailyLimit * 100)) : 0;
      const k = c.cardId.slice(-6);
      return `<section class="panel card-panel">${cardArt(c, a)}
        <dl><div><dt>Taken from ATMs today</dt><dd>${money(c.spentToday)}${c.dailyLimit ? ` of ${money(c.dailyLimit)}` : ''}</dd></div>
        <div><dt>In your inventory</dt><dd>${c.carried ? 'Yes' : 'No'}</dd></div></dl>
        ${c.dailyLimit ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ''}
        <div class="btns">
          <button type="button" data-k="cf-${k}" data-act="card" data-v="${c.status === 'blocked' ? 'unfreeze' : 'freeze'}" data-card="${c.cardId}">${c.status === 'blocked' ? 'Unfreeze' : 'Freeze'}</button>
          <button type="button" data-k="cl-${k}" data-act="card" data-v="limit" data-card="${c.cardId}">Daily limit</button>
          <button type="button" data-k="cn-${k}" data-act="card" data-v="rename" data-card="${c.cardId}">Rename</button>
          <button type="button" class="danger" data-k="cr-${k}" data-act="card" data-v="revoke" data-card="${c.cardId}">Cancel card</button>
        </div></section>`; }).join('')}</div>`
      : `<p class="empty">${canIssue ? 'No cards on this account yet. A debit card works at every ATM in the city.' : 'Cards can be issued for accounts you can withdraw from.'}</p>`}`;
}

function viewVaults() {
  const p = snap().plus || {}, vaults = p.vaults || [], max = p.limits?.vaults || 0;
  return `<header class="v-head"><h1>Vaults</h1>${vaults.length < max ? '<button type="button" class="primary" data-k="v-new" data-act="vaultNew">New vault</button>' : ''}</header>
    ${vaults.length ? `<div class="vault-grid">${vaults.map(v => {
      const locked = v.lockedUntil > Date.now() / 1000;
      return `<section class="panel vault v-${v.colour}">
        <div class="vault-top">${jar(v, 84)}
          <div><h2>${h(v.name)}</h2><strong>${money(v.balance)}</strong>
          <small>${v.goal ? `${Math.floor((v.progress || 0) * 100)}% of ${money(v.goal)}` : 'No goal set'}</small></div></div>
        <ul class="facts">
          <li>${locked ? `${icon('M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5z')}Locked until ${h(fmtFull.format(when(v.lockedUntil)))}` : `${icon('M7 11V8a5 5 0 0 1 9.6-2M5 11h14v10H5z')}Unlocked`}</li>
          <li>${icon('M4 18 10 12l4 4 6-8')}${v.rate}% interest, ${money(v.interestEarned)} earned so far</li>
        </ul>
        <div class="btns">
          <button type="button" class="primary" data-k="vi-${v.id}" data-act="vault" data-v="in" data-id="${v.id}">Add money</button>
          <button type="button" data-k="vo-${v.id}" data-act="vault" data-v="out" data-id="${v.id}" ${locked ? 'disabled' : ''}>Take out</button>
          <button type="button" data-k="ve-${v.id}" data-act="vault" data-v="edit" data-id="${v.id}">Edit</button>
          <button type="button" class="danger" data-k="vc-${v.id}" data-act="vault" data-v="close" data-id="${v.id}" ${locked ? 'disabled' : ''}>Close</button>
        </div></section>`; }).join('')}</div>`
      : `<p class="empty">A vault is a jar for one goal. Lock it so you can't dip in, and it earns interest while you're in the city.</p>`}`;
}

function requestRow(r) {
  return `<div class="req"><span class="cat c-people">${icon(CATS[8][2])}</span><span class="r-main"><b>${h(r.name)}</b><small>${h(r.note || 'Payment request')} · ${h(relDay(r.createdAt))}</small></span>
    <b class="r-val">${money(r.amount)}</b><span class="btns">
    <button type="button" class="primary" data-k="rp-${r.id}" data-act="request" data-v="pay" data-id="${r.id}">Pay</button>
    <button type="button" data-k="rd-${r.id}" data-act="request" data-v="decline" data-id="${r.id}">Decline</button></span></div>`;
}

function viewPayments() {
  const p = snap().plus || {}, so = p.schedules || [], inc = p.requests?.incoming || [], out = p.requests?.outgoing || [];
  const a = account();
  const STATUS = { pending: 'Waiting', paid: 'Paid', declined: 'Declined', cancelled: 'Withdrawn', expired: 'Expired', paying: 'Paying' };
  return `<header class="v-head"><h1>Payments</h1><div class="btns">
      <button type="button" data-k="p-tf" data-act="move" data-v="transfer" ${a && !a.frozen && a.canWithdraw !== false ? '' : 'disabled'}>Transfer</button>
      <button type="button" class="primary" data-k="p-so" data-act="schedule" ${a && a.canWithdraw !== false ? '' : 'disabled'}>New standing order</button></div></header>
    <section class="panel"><h2>Standing orders</h2>${so.length ? `<ol class="rows">${so.map(x => `<li class="row-static">
      <span class="cat c-bills">${icon('M4 6h16v14H4zM4 10h16M8 3v4m8-4v4')}</span>
      <span class="r-main"><b>${money(x.amount)} to ${h(x.toLabel)}</b><small>${h(x.label ? x.label + ', ' : '')}${h((EVERY[x.everyHours] || `Every ${x.everyHours} hours`).toLowerCase())}, from ${h(accountById(x.fromAccountId)?.name || 'an account')}${x.runsLeft ? `, ${x.runsLeft} left` : ''}</small>
        ${x.status === 'paused' ? `<small class="warn">Paused${x.lastError ? ': ' + h(x.lastError) : ''}</small>` : `<small>Next ${h(relDay(x.nextRunAt))}</small>`}</span>
      <span class="btns">${x.status === 'active'
        ? `<button type="button" data-k="sn-${x.id}" data-act="so" data-v="run" data-id="${x.id}">Pay now</button><button type="button" data-k="sp-${x.id}" data-act="so" data-v="pause" data-id="${x.id}">Pause</button>`
        : `<button type="button" data-k="sr-${x.id}" data-act="so" data-v="resume" data-id="${x.id}">Resume</button>`}
        <button type="button" class="danger" data-k="sc-${x.id}" data-act="so" data-v="cancel" data-id="${x.id}">Cancel</button></span></li>`).join('')}</ol>`
      : '<p class="muted">Pay rent, an allowance or your own vault automatically.</p>'}</section>
    <div class="cols even">
      <section class="panel"><h2>Asked of you</h2>${inc.length ? inc.map(requestRow).join('') : '<p class="muted">No one is waiting on you.</p>'}</section>
      <section class="panel"><h2>You asked</h2>${out.length ? out.map(r => `<div class="req"><span class="cat c-people">${icon(CATS[8][2])}</span><span class="r-main"><b>${h(r.name)}</b><small>${h(r.note || 'Payment request')}${r.group ? ', split' : ''}</small></span>
        <b class="r-val">${money(r.amount)}</b><span class="tag t-${r.status}">${STATUS[r.status] || h(r.status)}</span>
        ${r.status === 'pending' ? `<span class="btns"><button type="button" data-k="rc-${r.id}" data-act="request" data-v="cancel" data-id="${r.id}">Withdraw</button></span>` : ''}</div>`).join('')
        : '<p class="muted">Ask someone for money, or split a bill, from the Bank app on your phone.</p>'}</section>
    </div>`;
}

function viewInsights() {
  const a = account(), i = state.insights;
  if (!a) return `<header class="v-head"><h1>Insights</h1></header><p class="empty">Pick an account first.</p>`;
  if (!i || i.accountId !== +a.id) return `<header class="v-head"><h1>Insights for ${h(a.name)}</h1></header><p class="empty">${state.insightsError ? h(state.insightsError) : 'Reading your statement…'}</p>`;
  const change = i.previousOut ? Math.round((i.monthOut - i.previousOut) / i.previousOut * 100) : null;
  const top = Math.max(1, ...i.days.map(d => Math.max(d.in, d.out)));
  const bw = 600 / i.days.length;
  const bars = i.days.map((d, n) => {
    const x = n * bw, hi = d.in / top * 120, ho = d.out / top * 120;
    return `<rect class="b-in" rx="2" x="${(x + bw * .14).toFixed(1)}" y="${(130 - hi).toFixed(1)}" width="${(bw * .34).toFixed(1)}" height="${hi.toFixed(1)}"><title>${fmtDay.format(when(d.day))}: in ${money(d.in)}</title></rect>` +
      `<rect class="b-out" rx="2" x="${(x + bw * .52).toFixed(1)}" y="${(130 - ho).toFixed(1)}" width="${(bw * .34).toFixed(1)}" height="${ho.toFixed(1)}"><title>${fmtDay.format(when(d.day))}: out ${money(d.out)}</title></rect>`;
  }).join('');
  return `<header class="v-head"><h1>Insights for ${h(a.name)}</h1><span class="muted">Last 30 days</span></header>
    <div class="kpis">
      <div class="panel"><span>Money in</span><strong class="in">${money(i.monthIn)}</strong></div>
      <div class="panel"><span>Money out</span><strong>${money(i.monthOut)}</strong>${change !== null ? `<small>${change > 0 ? `${change}% more` : change < 0 ? `${-change}% less` : 'The same'} than the 30 days before</small>` : ''}</div>
      <div class="panel"><span>Left over</span><strong class="${i.net >= 0 ? 'in' : 'out'}">${signed(i.net)}</strong><small>About ${money(i.averageDaily)} spent a day</small></div>
    </div>
    <div class="cols">
      <section class="panel"><header class="ph-row"><h2>Last 14 days</h2><span class="legend"><i class="l-in"></i>In <i class="l-out"></i>Out</span></header>
        <svg class="bars" viewBox="0 0 600 140" preserveAspectRatio="none" role="img" aria-label="Money in and out per day">${bars}<path class="axis" d="M0 130.5H600"/></svg>
        <div class="bar-x"><span>${fmtDay.format(when(i.days[0].day))}</span><span>Today</span></div>
        ${i.biggest ? `<p class="muted biggest">Biggest payment: ${money(i.biggest.amount)} for ${h(i.biggest.text)}, ${h(relDay(i.biggest.at))}.</p>` : ''}</section>
      <section class="panel"><h2>Where it went</h2>${i.categories.length ? donut(i, 170) : '<p class="muted">No spending in the last 30 days.</p>'}</section>
    </div>`;
}

function viewStatement() {
  const a = account(), st = state.statement;
  if (!a) return `<header class="v-head"><h1>Statements</h1></header><p class="empty">Pick an account first.</p>`;
  return `<header class="v-head"><h1>Statement</h1><span class="muted">${h(a.name)} · ${h(serial(a.number))}</span></header>
    <section class="panel paper">${microprint()}${st ? ledgerRows(st.items, true) : '<p class="empty">Loading the statement…</p>'}
    ${st ? `<nav class="pager"><button type="button" data-k="pg-prev" data-act="page" data-v="-1" ${st.page <= 1 ? 'disabled' : ''}>Newer</button>
      <span>Page ${st.page}</span><button type="button" data-k="pg-next" data-act="page" data-v="1" ${st.hasMore ? '' : 'disabled'}>Older</button></nav>` : ''}</section>`;
}

const VIEW_RENDER = { overview: viewOverview, accounts: viewAccounts, cards: viewCards, vaults: viewVaults,
  payments: viewPayments, insights: viewInsights, statement: viewStatement };

/** The bank's colour, only as a #rrggbb (it is put into a style attribute). */
const brand = () => (/^#[0-9a-fA-F]{6}$/.test(snap().bank?.colour || '') ? snap().bank.colour : '#1f9e74');

function seal(name) {
  const letter = h((name || 'B').trim()[0] || 'B');
  return `<span class="seal" aria-hidden="true">${guilloche(80, 80, 5)}<b>${letter}</b></span>`;
}

function renderBranch() {
  const s = snap(), b = s.bank || {};
  const waiting = (s.plus?.requests?.incoming || []).length;
  const today = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date());
  return `<div class="branch" style="--brand:${brand()}">
    <header class="topbar">
      <div class="brand">${seal(b.name)}<span><b>${h(b.name || 'Bank')}</b><small>${h(b.tagline || '')}</small></span></div>
      <div class="session"><span class="where">${h(b.branch ? b.branch + ' branch' : 'Branch')}, ${h(today)}</span>
        <span class="secure">${icon('M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5z')}Signed in as ${h(s.characterName || '')}</span>
        <button type="button" data-k="close" data-act="close">Sign out <kbd>Esc</kbd></button></div>
    </header>
    <div class="frame">
      <nav class="rail" aria-label="Banking">
        ${VIEWS.map(([id, label, d]) => `<button type="button" data-k="nav-${id}" data-act="view" data-v="${id}" aria-current="${state.view === id ? 'page' : 'false'}">${icon(d)}<span>${label}</span>${id === 'payments' && waiting ? `<em>${waiting}</em>` : ''}</button>`).join('')}
        <div class="wallet"><span>Cash in your wallet</span><b>${money(s.cash)}</b></div>
      </nav>
      <section class="stage" aria-live="polite">
        ${state.notice ? `<p class="notice ${state.notice.kind}" role="status">${h(state.notice.text)}</p>` : ''}
        ${VIEW_RENDER[state.view]()}
      </section>
    </div>
    ${pad ? `<footer class="hints"><span><img src="https://cfx-nui-whip_core/html/img/pad/dpad.svg" alt="">Move</span><span><img src="https://cfx-nui-whip_core/html/img/pad/a.svg" alt="">Select</span>
      <span><img src="https://cfx-nui-whip_core/html/img/pad/b.svg" alt="">Back</span><span><img src="https://cfx-nui-whip_core/html/img/pad/lb.svg" alt=""><img src="https://cfx-nui-whip_core/html/img/pad/rb.svg" alt="">Section</span>
      <span><img src="https://cfx-nui-whip_core/html/img/pad/x.svg" alt="">Refresh</span></footer>` : ''}
  </div>`;
}

function renderSheet() {
  const f = state.form;
  if (!f) return '';
  const def = FORMS[f.kind];
  return `<div class="scrim" style="--brand:${brand()}"><section class="sheet" role="dialog" aria-modal="true" aria-label="${h(def.title(f))}">
    <header><h2>${h(def.title(f))}</h2><button type="button" class="x" data-k="sheet-x" data-act="closeForm" aria-label="Close">${icon('M6 6l12 12M18 6 6 18')}</button></header>
    ${f.error ? `<p class="notice error" role="alert">${h(f.error)}</p>` : ''}${def.body(f)}</section></div>`;
}

// ---------------------------------------------------------------- ATM
function atmCards() { return (snap().cards || []).filter(c => c.carried && c.status === 'active'); }

function renderAtm() {
  const s = snap(), a = state.atm, b = s.bank || {};
  const acct = account();
  const left = [], right = [];
  let screen = '';
  const key = (side, k, label, act, v = '', dis = false) => (side === 'l' ? left : right).push(
    `<button type="button" class="soft" data-k="${k}" data-act="${act}" data-v="${h(v)}" ${dis || state.busy ? 'disabled' : ''}><span>${h(label)}</span></button>`);
  if (a.step === 'card') {
    const cards = atmCards();
    screen = `<h2>${a.ejected ? 'Please take your card' : 'Welcome'}</h2><p>${cards.length ? 'Choose the card to insert.' : 'You need a debit card in your inventory. Cards are issued at a bank branch.'}</p>
      <div class="atm-cards">${cards.map(c => `<button type="button" data-k="ins-${c.cardId.slice(-6)}" data-act="insert" data-v="${c.cardId}" ${state.busy ? 'disabled' : ''}>${cardArt(c, accountById(c.accountId))}</button>`).join('')}</div>`;
    key('r', 'cancel', 'Cancel', 'close');
  } else if (a.step === 'pin') {
    screen = `<h2>Enter your PIN</h2><p>Cover the keypad. Three wrong tries lock the card for five minutes.</p>${pinPad(a.pin, '')}`;
    key('l', 'pin-ok', 'Enter', 'atmPin', '', a.pin.length !== 4);
    key('r', 'eject', 'Cancel', 'eject');
  } else if (a.step === 'menu') {
    const fast = (s.fastCash || []).filter(v => v <= Math.min(acct?.balance || 0, s.limit));
    screen = `<h2>Hello, ${h((s.characterName || '').split(' ')[0])}</h2><p>${h(acct?.name || '')}. Choose an amount or a service.</p>`;
    fast.slice(0, 4).forEach((v, i) => key('l', 'fc-' + i, money(v), 'atmCash', v));
    key('r', 'other', 'Other amount', 'atmOther');
    key('r', 'bal', 'Balance', 'atmShow', 'balance');
    key('r', 'mini', 'Mini statement', 'atmShow', 'mini');
    key('r', 'eject', 'Return card', 'eject');
  } else if (a.step === 'other') {
    screen = `<h2>Other amount</h2><p>Whole dollars, up to ${money(Math.min(s.limit, acct?.balance || 0))} at this machine.</p>
      <button type="button" class="atm-amount" data-k="amt" data-act="atmAmount">${a.amount ? money(a.amount) : '<span class="ph">Type an amount</span>'}</button>`;
    key('l', 'amt-ok', 'Withdraw', 'atmCash', a.amount, !a.amount);
    key('r', 'back', 'Back', 'atmMenu');
  } else if (a.step === 'balance') {
    screen = `<h2>Your balance</h2><p class="atm-big">${money(acct?.balance)}</p><p>${h(acct?.name || '')}, ${h(acct?.number || '')}</p>`;
    key('r', 'back', 'Back', 'atmMenu');
    key('r', 'eject', 'Return card', 'eject');
  } else if (a.step === 'mini') {
    screen = `<h2>Mini statement</h2>${ledgerRows(s.recent.slice(0, 5))}`;
    key('r', 'back', 'Back', 'atmMenu');
  } else if (a.step === 'receipt') {
    screen = `<h2>Take your cash</h2><div class="receipt"><span>${h(b.name || 'Bank')} ATM</span><span>${h(fmtFull.format(new Date()))}</span>
      <span>Withdrawn</span><b>${money(a.last)}</b><span>Available balance</span><b>${money(acct?.balance)}</b><span>Card</span><b>•••• ${h(a.lastFour || '')}</b></div>`;
    key('l', 'again', 'Another service', 'atmMenu');
    key('r', 'eject', 'Return card', 'eject');
  }
  if (state.busy) screen += `<p class="atm-wait">Please wait…</p>`;
  return `<div class="atm"><div class="atm-bezel"><header class="atm-head"><b>${h(b.name || 'Bank')}</b><span>${h(fmtTime.format(new Date()))}</span></header>
    <div class="atm-body"><div class="softs l">${left.join('')}</div><div class="atm-screen">
      ${state.notice ? `<p class="notice ${state.notice.kind}" role="status">${h(state.notice.text)}</p>` : ''}${screen}</div>
      <div class="softs r">${right.join('')}</div></div></div>
    <div class="atm-slot" aria-hidden="true"><i class="${a.step !== 'card' ? 'in' : ''}"></i></div>
    ${pad ? `<footer class="hints"><span><img src="https://cfx-nui-whip_core/html/img/pad/a.svg" alt="">Select</span><span><img src="https://cfx-nui-whip_core/html/img/pad/b.svg" alt="">Back</span>${a.step === 'pin' ? '<span><img src="https://cfx-nui-whip_core/html/img/pad/x.svg" alt="">Delete</span>' : ''}</footer>` : ''}</div>`;
}

// ---------------------------------------------------------------- render
function render() {
  if (!state) return;
  const active = document.activeElement?.dataset?.k;
  app.dataset.mode = snap().mode;
  app.classList.toggle('pad', pad);
  app.innerHTML = (atm() ? renderAtm() : renderBranch() + renderSheet());
  if (active) focusKey(active, false);
  if (pad && !app.contains(document.activeElement)) focusFirst(state.form ? '.sheet' : '');
}
function focusKey(k, scroll = true) {
  const node = k && app.querySelector(`[data-k="${CSS.escape(k)}"]`);
  if (!node || node.disabled) return false;
  node.focus({ preventScroll: !scroll });
  if (scroll) node.scrollIntoView({ block: 'nearest' });
  return true;
}
function focusFirst(scope) {
  const root = scope ? app.querySelector(scope) : app;
  const node = root && [...root.querySelectorAll('button')].find(b => !b.disabled);
  if (node) { node.focus({ preventScroll: true }); return true; }
  return false;
}

// ---------------------------------------------------------------- actions
const ACTIONS = {
  close: () => close(),
  view(v) {
    state.view = v; state.notice = null; state.returnKey = 'nav-' + v;
    if (v === 'statement') loadStatement(1);
    if (v === 'insights' || v === 'overview') loadInsights();
    render();
  },
  selectAccount(_, el) { run(async c => { await reload(c, el.dataset.id); if (c.view === 'insights' || c.view === 'overview') loadInsights(); if (c.view === 'statement') loadStatement(1); }); },
  move(v) { state.returnKey = 'mv-' + v; openForm('move', {}, { action: v }); },
  openAccount: () => openForm('openAccount', { kind: 'savings' }),
  issueCard: () => openForm('issueCard', { pin: '' }),
  card(v, el) {
    const a = account(), cardId = el.dataset.card, c = cardsFor(a.id).find(x => x.cardId === cardId);
    if (!c) return;
    if (v === 'limit') return openForm('cardLimit', { limit: c.dailyLimit ? String(c.dailyLimit) : '' }, { account: +a.id, card: cardId });
    if (v === 'rename') return openForm('cardName', { name: c.nickname || '' }, { account: +a.id, card: cardId });
    if (v === 'revoke') return openForm('confirm', {}, { heading: `Cancel card ${c.lastFour}?`, yes: 'Cancel card', danger: true, done: 'Card cancelled.',
      text: 'It stops working everywhere at once and cannot be turned back on. Use Freeze if you might find it.',
      run: () => plus('cardControl', { account: +a.id, card: cardId, action: 'revoke' }) });
    run(async cur => { await plus('cardControl', { account: +a.id, card: cardId, action: v }); await finish(cur, v === 'freeze' ? 'Card frozen. ATMs refuse it until you unfreeze it.' : 'Card unfrozen.'); });
  },
  vaultNew: () => openForm('vaultNew', { colour: 'blue' }),
  vault(v, el) {
    const id = el.dataset.id, vault = vaultOf(id);
    if (!vault) return;
    if (v === 'in' || v === 'out') return openForm('vaultMove', {}, { vault: id, direction: v });
    if (v === 'edit') return openForm('vaultEdit', { goal: vault.goal ? String(vault.goal) : '', colour: vault.colour }, { vault: id });
    if (v === 'close') return openForm('vaultClose', {}, { vault: id });
  },
  schedule: () => openForm('schedule', { toKind: 'mine' }),
  so(v, el) {
    const id = +el.dataset.id;
    if (v === 'cancel') return openForm('confirm', {}, { heading: 'Cancel this standing order?', yes: 'Cancel it', danger: true, done: 'Standing order cancelled.',
      text: 'No more payments go out. Payments already made stay made.', run: () => plus('scheduleControl', { id, action: 'cancel' }) });
    run(async cur => { await plus('scheduleControl', { id, action: v });
      await finish(cur, { run: 'Paid. The next one follows on its usual schedule.', pause: 'Paused.', resume: 'Resumed.' }[v]); });
  },
  request(v, el) {
    const id = +el.dataset.id, r = [...(snap().plus?.requests?.incoming || [])].find(x => x.id === id);
    if (v === 'pay' && r) return openForm('payRequest', {}, { id, amount: r.amount, name: r.name, note: r.note });
    run(async cur => { await plus('requestAnswer', { id, action: v }); await finish(cur, v === 'decline' ? 'Request declined.' : 'Request withdrawn.'); });
  },
  page(v) { loadStatement((state.statement?.page || 1) + +v); },
  closeForm: () => closeForm(),
  formBack() { state.form.step = 'edit'; render(); },
  submit: () => submitForm(),
  // ATM
  insert(cardId) {
    const c = atmCards().find(x => x.cardId === cardId);
    if (!c) return;
    run(async cur => {
      cur.notice = null;
      await call('insertCard', { accountId: String(c.accountId), cardId });
      cur.atm = { step: 'pin', pin: '', cardId, accountId: String(c.accountId), lastFour: c.lastFour };
    });
  },
  atmPin() {
    const a = state.atm;
    if (a.pin.length !== 4) return;
    run(async cur => {
      const pin = a.pin; a.pin = '';
      try { await call('unlockCard', { accountId: a.accountId, cardId: a.cardId, pin }); }
      catch (e) { cur.notice = { text: e.message, kind: 'error' }; return; }
      await reload(cur, a.accountId);
      cur.notice = null; a.step = 'menu';
    });
  },
  atmMenu() { state.atm.step = 'menu'; state.notice = null; state.atm.amount = 0; render(); },
  atmShow(v) { state.atm.step = v; render(); },
  atmOther() { state.atm.step = 'other'; state.atm.amount = 0; render(); },
  async atmAmount() {
    if (editing) return;
    editing = true;
    try { const r = await call('editField', { field: 'atm-amount', value: state.atm.amount ? String(state.atm.amount) : '' });
      if (state && r && !r.cancelled) state.atm.amount = whole(r.value); }
    catch (e) { if (state) state.notice = { text: e.message, kind: 'error' }; }
    finally { editing = false; render(); }
  },
  atmCash(v) {
    const amount = whole(v), a = state.atm, acct = account();
    if (!amount) return;
    if (amount > (acct?.balance || 0)) return notice('Your balance is too low for that.', 'error');
    if (amount > snap().limit) return notice(`This machine pays up to ${money(snap().limit)} at a time.`, 'error');
    run(async cur => {
      await call('withdraw', { accountId: acct.id, amount, requestId: uuid() });
      a.last = amount; a.step = 'receipt';
      try { await reload(cur, acct.id); } catch { /* the receipt still stands */ }
    });
  },
  eject() {
    run(async cur => {
      try { await call('ejectCard'); } catch { /* the session may have ended */ }
      cur.atm = { step: 'card', pin: '', ejected: true };
      cur.notice = null;
      try { await reload(cur, 0); } catch { /* keep the old list */ }
    });
  },
};

async function loadStatement(page) {
  const current = state, a = account();
  if (!a) return;
  current.statement = current.statement && current.statement.accountId === a.id ? current.statement : null;
  render();
  try {
    const st = await call('getStatement', { accountId: a.id, page });
    if (state === current) { st.accountId = a.id; current.statement = st; render(); }
  } catch (e) { if (state === current) notice(e.message, 'error'); }
}
async function loadInsights() {
  const current = state, a = account();
  if (!a) return;
  current.insightsError = null;
  try { const i = await plus('insights', { account: +a.id }); if (state === current) { current.insights = i; render(); } }
  catch (e) { if (state === current) { current.insightsError = e.message; render(); } }
}

function pinInput(k) {
  const target = state.atm && state.atm.step === 'pin' ? state.atm : state.form?.values;
  if (!target) return;
  const v = target.pin || '';
  target.pin = k === 'del' ? v.slice(0, -1) : k === 'clear' ? '' : v.length < 4 ? v + k : v;
  render();
}

app.addEventListener('click', e => {
  const el = e.target.closest('button');
  if (!el || el.disabled || !state || editing) return;
  if (el.dataset.pin) return pinInput(el.dataset.pin);
  if (el.dataset.edit) return editField(el.dataset.edit, el.dataset.key);
  if (el.dataset.set && state.form) { state.form.values[el.dataset.set] = el.dataset.v; state.form.error = null; return render(); }
  const act = el.dataset.act;
  if (act && ACTIONS[act] && !(state.busy && act !== 'close')) ACTIONS[act](el.dataset.v, el);
});

// ---------------------------------------------------------------- open / close
async function open(event) {
  if (!event || event.type !== 'bank:open' || !event.snapshot || event.generation <= latestGeneration) return;
  latestGeneration = event.generation;
  const s = event.snapshot;
  normalise(s);
  const current = { snapshot: s, view: 'overview', busy: true, form: null, notice: null,
    atm: { step: s.atmAccountId ? 'menu' : 'card', pin: '' } };
  state = current;
  theme(s.theme);
  app.hidden = false;
  render();
  try {
    const rendered = await call('rendered', { generation: event.generation });
    if (state !== current) return;
    current.busy = false;
    setPad(rendered?.pad === true);
    render();
    if (!atm()) loadInsights();
    if (!pad) app.focus({ preventScroll: true });
  } catch { if (state === current) hide(); }
}
function hide() { state = null; app.hidden = true; app.innerHTML = ''; }
async function close() {
  const current = state;
  if (!current || current.closing) return;
  current.closing = true;
  try { await call('close'); if (state === current) hide(); }
  catch (e) { if (state === current) { current.closing = false; notice(e.message, 'error'); } }
}
function theme(name) {
  $('whip-theme')?.remove();
  if (typeof name !== 'string' || !/^[\w-]+$/.test(name)) return;
  const link = Object.assign(document.createElement('link'), { id: 'whip-theme', rel: 'stylesheet', href: `https://cfx-nui-${name}/theme.css` });
  document.head.append(link);
}

// ---------------------------------------------------------------- controller + keys
function setPad(on) { if (pad === on) return; pad = on; render(); }
function back() {
  if (!state || editing) return;
  if (state.form) return state.form.step === 'review' ? ACTIONS.formBack() : closeForm();
  if (atm()) {
    const step = state.atm.step;
    if (['other', 'balance', 'mini', 'receipt'].includes(step)) return ACTIONS.atmMenu();
    if (step === 'pin' || step === 'menu') return ACTIONS.eject();
    return close();
  }
  if (state.view !== 'overview') return ACTIONS.view('overview');
  close();
}
function moveFocus(dir) {
  const scope = state.form ? app.querySelector('.sheet') : app;
  const nodes = [...scope.querySelectorAll('button')].filter(n => !n.disabled && n.getClientRects().length);
  const cur = document.activeElement;
  if (!nodes.includes(cur)) return nodes[0]?.focus();
  const a = cur.getBoundingClientRect(), ax = a.left + a.width / 2, ay = a.top + a.height / 2;
  const v = dir === 'up' || dir === 'down', sign = dir === 'up' || dir === 'left' ? -1 : 1;
  const best = nodes.filter(n => n !== cur).map(n => {
    const b = n.getBoundingClientRect(), dx = b.left + b.width / 2 - ax, dy = b.top + b.height / 2 - ay;
    const fwd = (v ? dy : dx) * sign;
    return { n, fwd, score: fwd + Math.abs(v ? dx : dy) * 2.5 };
  }).filter(x => x.fwd > 4).sort((x, y) => x.score - y.score)[0];
  if (best) { best.n.focus({ preventScroll: true }); best.n.scrollIntoView({ block: 'nearest' }); }
}
function onPad(e) {
  if (previewSequence !== null) { if (e.down !== false && (e.cmd === 'b' || e.cmd === 'a')) closeCardPreview(); return; }
  if (!state || app.hidden || e.down === false) return;
  setPad(true);
  if (editing || state.busy) return;
  if (e.cmd === 'b') return back();
  if (['up', 'down', 'left', 'right'].includes(e.cmd)) return moveFocus(e.cmd);
  if (e.cmd === 'x') {
    if (atm() && state.atm.step === 'pin') return pinInput('del');
    if (!atm() && !state.form) return run(c => reload(c));
    return;
  }
  if ((e.cmd === 'lb' || e.cmd === 'rb') && !atm() && !state.form) {
    const i = VIEWS.findIndex(v => v[0] === state.view);
    const next = VIEWS[(i + (e.cmd === 'rb' ? 1 : -1) + VIEWS.length) % VIEWS.length][0];
    ACTIONS.view(next);
    return focusKey('nav-' + next);
  }
  if (e.cmd === 'rb' && state.form?.kind === 'issueCard') return submitForm();
  if (e.cmd === 'a') { if (!app.contains(document.activeElement)) focusFirst(state.form ? '.sheet' : ''); document.activeElement?.click(); }
}
document.addEventListener('keydown', e => {
  if (previewSequence !== null && e.key === 'Escape') { e.preventDefault(); return closeCardPreview(); }
  if (!state || editing) return;
  if (e.key === 'Escape') { e.preventDefault(); return back(); }
  const pinOpen = (atm() && state.atm.step === 'pin') || state.form?.kind === 'issueCard';
  if (pinOpen && /^\d$/.test(e.key)) return pinInput(e.key);
  if (pinOpen && e.key === 'Backspace') return pinInput('del');
  if (pinOpen && e.key === 'Enter') { e.preventDefault(); return atm() ? ACTIONS.atmPin() : submitForm(); }
});
document.addEventListener('mousemove', () => { if (pad && state) setPad(false); }, { passive: true });

window.addEventListener('message', e => {
  const d = e.data || {};
  if (d.type === 'card:open') return showCardPreview(d);
  if (d.type === 'card:close') return hideCardPreview();
  if (d.action === 'padDevice') return previewSequence === null && setPad(d.pad === true);
  if (d.action === 'pad') return onPad(d);
  if (d.type === 'bank:close') return hide();
  open(d).catch(report);
});

// ---------------------------------------------------------------- card preview (using a card from the inventory)
function hideCardPreview() {
  previewSequence = null;
  $('card-preview').hidden = true;
  for (const id of ['preview-holder', 'preview-account-name', 'preview-account-number', 'preview-card-status', 'preview-last-four', 'preview-error']) $(id).textContent = '';
}
async function showCardPreview(event) {
  if (state || !event.card || !Number.isInteger(event.sequence)) return;
  previewSequence = event.sequence;
  const c = event.card;
  $('preview-holder').textContent = c.holder || 'Account holder';
  $('preview-account-name').textContent = c.accountName || 'Account';
  $('preview-account-number').textContent = c.accountNumber || '';
  $('preview-card-status').textContent = c.status ? c.status[0].toUpperCase() + c.status.slice(1) : 'Unavailable';
  $('preview-card-status').dataset.status = c.status;
  $('preview-last-four').textContent = 'Card ending ' + (c.lastFour || '');
  $('card-preview').hidden = false;
  try { await call('cardReady', { sequence: event.sequence }); if (previewSequence === event.sequence) $('card-preview-close').focus(); }
  catch { if (previewSequence === event.sequence) hideCardPreview(); }
}
async function closeCardPreview() {
  const seq = previewSequence;
  try { await call('cardClose'); if (seq === previewSequence) hideCardPreview(); }
  catch { $('preview-error').textContent = 'The card did not close. Try again.'; }
}
$('card-preview-close').addEventListener('click', closeCardPreview);

function report(error) { call('uiError', { message: String(error).slice(0, 400) }).catch(() => {}); }
window.addEventListener('error', e => report(e.message));
call('ready').then(e => (e?.type === 'card:open' ? showCardPreview(e) : open(e))).catch(report);

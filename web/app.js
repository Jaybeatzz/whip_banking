'use strict';

const el = id => document.getElementById(id);
const bank = el('bank');
const quickCash = [...document.querySelectorAll('[data-amount]')];
const actions = [...document.querySelectorAll('[data-action]')];
const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const shortDates = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const dates = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' });
const resource = window.GetParentResourceName?.() || location.hostname.replace(/^cfx-nui-/, '');
const labels = { deposit: 'Deposit', withdraw: 'Withdrawal', transfer: 'Transfer' };
let session;
let latestGeneration = 0;
let controllerActive = false;
let editingField = false;
let pinDraft = '';
let pinReturn;
let dropdownSelect = null;
let dropdownIndex = 0;
let previewSequence = null;

async function call(name, data = {}) {
  let response;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    response = await fetch('https://' + resource + '/' + name, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    response = await response.json();
  } catch {
    const message = labels[name] ? 'No confirmation received. Check your statement or retry the same confirmation.'
      : 'Banking did not respond. Try again.';
    throw new Error(message);
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) throw new Error(response.error?.message || 'The banking request could not be completed.');
  return response.data;
}

function notice(text = '', kind = '') {
  el('notice').dataset.kind = kind;
  el('notice').textContent = text;
}

function selected() {
  return session.snapshot.accounts.find(account => account.id === session.snapshot.selectedAccountId);
}

function theme(name) {
  document.getElementById('whip-theme')?.remove();
  if (typeof name !== 'string' || !/^[\w-]+$/.test(name)) return;
  const link = document.createElement('link');
  link.id = 'whip-theme';
  link.rel = 'stylesheet';
  link.href = 'https://cfx-nui-' + name + '/theme.css';
  document.head.append(link);
}

function updateControls() {
  const { snapshot, busy, action, confirmation, statement, stale, closing } = session;
  const account = selected();
  const locked = busy || closing;
  el('account').disabled = locked || Boolean(confirmation) || snapshot.accounts.length < 2;
  el('refresh').disabled = locked || Boolean(confirmation);
  el('close').disabled = locked;
  el('new-account').hidden = snapshot.mode === 'atm';
  el('new-account').disabled = locked || Boolean(confirmation);
  el('create-account').disabled = locked;
  el('cancel-account').disabled = locked;
  el('account-name').disabled = locked;
  el('account-kind').disabled = locked;
  const atm = snapshot.mode === 'atm';
  const accountCards = (snapshot.cards || []).filter(card => String(card.accountId) === account?.id);
  const carried = accountCards.filter(card => card.carried && card.status === 'active');
  const unlocked = snapshot.atmAccountId === account?.id;
  el('card-select-label').hidden = !atm || unlocked;
  el('card-select').hidden = !atm || unlocked;
  el('card-form').hidden = atm ? unlocked || !carried.length : !account || account.canWithdraw === false || account.frozen;
  el('card-submit').textContent = atm ? 'Verify PIN' : 'Issue debit card';
  el('pin-label').textContent = atm ? 'Four-digit PIN' : 'Choose a four-digit PIN';
  el('card-submit').disabled = locked || stale;
  el('card-pin').disabled = locked;
  el('card-select').disabled = locked;
  for (const button of el('card-list').querySelectorAll('button')) button.disabled = locked;
  el('card-status').textContent = snapshot.cardError || (atm
    ? unlocked ? 'Card verified for this account.' : carried.length ? 'Verify your card to withdraw cash.' : 'Carry an active debit card for this account. Cards are issued at a bank branch.'
    : 'Cards are issued to your inventory.');

  el('statement').disabled = locked || !account;
  el('overview-nav').disabled = locked;
  el('accounts-nav').disabled = locked;
  el('accounts-nav').hidden = snapshot.mode === 'atm';
  el('transactions-nav').disabled = locked || !account;
  el('previous').disabled = locked || !statement || statement.page <= 1;
  el('next').disabled = locked || !statement?.hasMore;
  el('fields').disabled = locked || Boolean(confirmation);
  el('fields').hidden = Boolean(confirmation);
  el('submit').disabled = locked || stale;
  el('cancel').disabled = locked;
  let availablePresets = 0;
  for (const button of quickCash) {
    const amount = Number(button.dataset.amount);
    button.hidden = !account || amount > Math.min(account.balance, snapshot.limit);
    if (!button.hidden) availablePresets += 1;
  }
  el('quick-cash').hidden = snapshot.mode !== 'atm' || !availablePresets || Boolean(confirmation);
  for (const button of actions) {
    button.hidden = snapshot.mode === 'atm' && button.dataset.action !== 'withdraw';
    button.disabled = locked || stale || !account || account.frozen || Boolean(confirmation)
      || (snapshot.mode === 'atm' && snapshot.atmAccountId !== account?.id)
      || (button.dataset.action === 'deposit' ? account.canDeposit === false : account.canWithdraw === false);
    button.setAttribute('aria-pressed', String(button.dataset.action === action));
  }
}

function renderTrend(snapshot) {
  const points = snapshot.recent.slice().reverse().filter(item =>
    Number.isFinite(item.balance) && Number.isFinite(Date.parse(item.date)));
  const shown = points.length >= 2;
  el('trend-figure').hidden = !shown;
  el('trend-empty').hidden = shown;
  el('trend-count').textContent = shown ? 'Last ' + points.length + ' posted balances' : '';
  if (!shown) return;

  const balances = points.map(item => item.balance);
  const high = Math.max(...balances);
  const low = Math.min(...balances);
  const coordinates = balances.map((balance, index) => {
    const x = index / (balances.length - 1) * 480;
    const y = high === low ? 59 : 110 - (balance - low) / (high - low) * 102;
    return x + ' ' + y;
  });
  const line = 'M' + coordinates.join(' L');
  el('trend-line').setAttribute('d', line);
  el('trend-area').setAttribute('d', line + ' V118 H0Z');
  el('trend-high').textContent = currency.format(high);
  el('trend-low').textContent = high === low ? '' : currency.format(low);
  for (const [id, point] of [['trend-start', points[0]], ['trend-end', points[points.length - 1]]]) {
    const time = el(id);
    time.dateTime = point.date;
    time.textContent = shortDates.format(new Date(point.date));
  }
}

function renderActivity() {
  const { snapshot, statement } = session;
  const items = statement?.items ?? snapshot.recent;
  const management = session.management && snapshot.mode !== 'atm';
  el('management').hidden = !management;
  el('activity').hidden = snapshot.mode === 'atm' || management;
  el('accounts-nav').setAttribute('aria-current', management ? 'page' : 'false');
  bank.dataset.view = management ? 'management' : statement ? 'transactions' : 'overview';
  el('trend').hidden = snapshot.mode === 'atm' || Boolean(statement) || management;
  el('overview-nav').setAttribute('aria-current', statement || management ? 'false' : 'page');
  el('transactions-nav').setAttribute('aria-current', statement && !management ? 'page' : 'false');
  if (!el('trend').hidden) renderTrend(snapshot);
  el('activity-title').textContent = statement ? 'Account statement' : 'Recent activity';
  el('statement').textContent = statement ? 'Back to activity' : 'View statement';
  el('running-balance').hidden = !statement;
  el('pages').hidden = !statement;
  if (statement) el('page').textContent = 'Page ' + statement.page;

  const rows = items.map(item => {
    const row = document.createElement('tr');
    const title = row.insertCell();
    const date = document.createElement('time');
    date.dateTime = item.date;
    const when = new Date(item.date);
    date.textContent = Number.isNaN(when.getTime()) ? '' : dates.format(when);
    const description = document.createElement('span');
    description.className = 'transaction-description';
    description.textContent = item.description;
    const sign = document.createElement('span');
    sign.className = 'transaction-direction';
    sign.setAttribute('aria-hidden', 'true');
    sign.textContent = item.amount > 0 ? '↙' : item.amount < 0 ? '↗' : '–';
    sign.classList.toggle('credit', item.amount > 0);
    const details = document.createElement('div');
    details.className = 'transaction-details';
    details.append(description, date);
    const entry = document.createElement('div');
    entry.className = 'transaction-entry';
    entry.append(sign, details);
    title.append(entry);
    const amount = row.insertCell();
    amount.textContent = (item.amount > 0 ? '+' : '') + currency.format(item.amount);
    amount.classList.toggle('credit', item.amount > 0);
    if (statement) row.insertCell().textContent = item.balance == null ? '—' : currency.format(item.balance);
    return row;
  });
  el('entries').replaceChildren(...rows);
  el('empty').hidden = rows.length > 0;
  el('empty').textContent = selected() ? 'No transactions to display.' : 'No personal accounts are available.';
  el('transactions').hidden = rows.length === 0;
}

function renderSnapshot() {
  const { snapshot } = session;
  const account = selected();
  const atm = snapshot.mode === 'atm';
  bank.dataset.mode = snapshot.mode;
  bank.classList.toggle('atm-unlocked', snapshot.mode === 'atm' && snapshot.atmAccountId === snapshot.selectedAccountId);
  el('movement-title').textContent = atm ? 'Cash withdrawal' : 'Move money';
  document.title = atm ? 'ATM' : 'Banking';
  el('title').textContent = document.title;
  el('customer').textContent = snapshot.characterName || '';
  el('account').replaceChildren(...snapshot.accounts.map(item => new Option(item.name, item.id)));
  if (!account) el('account').add(new Option('No personal accounts', ''));
  el('account').value = account?.id ?? '';
  el('account').classList.toggle('single-account', snapshot.accounts.length < 2);
  el('balance').textContent = account ? currency.format(account.balance) : '—';
  el('balance').classList.toggle('long-balance', el('balance').textContent.length >= 15);
  el('number').textContent = account ? account.number + (account.frozen ? ' · Frozen' : '') : '';
  el('account-access').textContent = account?.role
    ? (account.type === 'business' ? 'Business account' : account.type === 'shared' ? 'Shared account' : 'Personal account') + ' · ' + account.role + ' access' : '';
  el('account-form').hidden = !session.management;
  el('cash').textContent = currency.format(snapshot.cash);
  el('activity').hidden = atm;
  const cardManagement = el('card-management');
  if (atm) el('move').closest('.movement').before(cardManagement);
  else el('management').append(cardManagement);
  el('transactions-nav').hidden = atm;
  el('limit').textContent = 'Limit per transaction: ' + currency.format(snapshot.limit);
  renderCards();
  renderActivity();
  updateControls();
}

function renderCards() {
  const account = selected();
  const cards = (session.snapshot.cards || []).filter(card => String(card.accountId) === account?.id);
  el('card-select').replaceChildren(...cards.filter(card => card.carried && card.status === 'active')
    .map(card => new Option('Debit · ' + card.lastFour, card.cardId)));
  const rows = cards.map(card => {
    const row = document.createElement('div');
    row.className = 'card-row';
    const label = document.createElement('span');
    label.textContent = 'Debit · ' + card.lastFour + ' · ' + card.status;
    row.append(label);
    if (session.snapshot.mode === 'bank') {
      for (const action of [card.status === 'active' ? 'block' : 'unblock', 'revoke']) {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.card = card.cardId;
        button.dataset.cardAction = action;
        button.textContent = action[0].toUpperCase() + action.slice(1);
        row.append(button);
      }
    }
    return row;
  });
  el('card-list').replaceChildren(...rows);
  el('card-pin').value = '';
}

async function reloadCards(current, message) {
  current.snapshot = await call('getBankSnapshot', { accountId: selected().id });
  if (session !== current) return;
  current.statement = null;
  setAction(null);
  renderSnapshot();
  notice(message, 'success');
}

function setAction(action, focus = false) {
  session.action = action;
  bank.classList.toggle('is-editing', Boolean(action));
  session.confirmation = null;
  el('move').reset();
  el('move').hidden = !action;
  el('review').hidden = true;
  el('submit').textContent = 'Review';
  el('recipient-field').hidden = action !== 'transfer';
  el('recipient').required = action === 'transfer';
  updateControls();
  if (focus) el(action === 'transfer' ? 'recipient' : 'amount').focus();
}

async function run(work) {
  const current = session;
  if (!current || current.busy || current.closing) return;
  current.busy = true;
  updateControls();
  try {
    await work(current);
  } catch (error) {
    if (session === current) notice(error.message, 'error');
  } finally {
    if (session === current) {
      current.busy = false;
      updateControls();
      if (current.focus) {
        el(current.focus).focus();
        current.focus = null;
      }
    }
  }
}

function refresh(accountId = selected()?.id) {
  run(async current => {
    notice('Updating balances…');
    try {
      const snapshot = await call('getBankSnapshot', { accountId });
      if (session !== current) return;
      current.snapshot = snapshot;
      current.statement = null;
      current.stale = false;
      setAction(null);
      renderSnapshot();
      notice();
    } catch (error) {
      if (session === current) el('account').value = current.snapshot.selectedAccountId;
      throw error;
    }
  });
}

function openStatement(page) {
  run(async current => {
    notice('Loading statement…');
    const statement = await call('getStatement', { accountId: selected().id, page });
    if (session !== current) return;
    current.management = false;
    current.statement = statement;
    renderActivity();
    notice();
  });
}

function review(current) {
  const input = el('amount').value.trim();
  const amount = /^\d+$/.test(input) ? Number(input) : 0;
  const account = selected();
  const action = current.action;
  const limit = current.snapshot.limit;
  if (!account || current.stale) throw new Error('Refresh balances before continuing.');
  if (amount < 1 || amount > limit) throw new Error('Enter a whole-dollar amount from $1 to ' + currency.format(limit) + '.');
  const available = action === 'deposit' ? current.snapshot.cash : account.balance;
  if (amount > available) throw new Error(action === 'deposit' ? 'You do not have enough cash.' : 'Your account balance is too low.');

  const data = { accountId: account.id, amount, requestId: crypto.randomUUID() };
  const accountNumber = el('recipient').value.trim().toUpperCase();
  return { data, account, action, accountNumber };
}

async function buildConfirmation(current) {
  const { data, account, action, accountNumber } = review(current);
  const amount = currency.format(data.amount);
  let details;
  if (action === 'transfer') {
    if (!/^WB-\d{6}$/.test(accountNumber)) throw new Error('Enter a recipient account number like WB-123456.');
    notice('Checking recipient…');
    const recipient = await call('resolveRecipient', { accountId: account.id, accountNumber, amount: data.amount });
    if (session !== current) return;
    data.recipientToken = recipient.token;
    details = 'From ' + account.name + ' to ' + recipient.name + ' (' + recipient.maskedNumber + ').';
  } else if (action === 'deposit') {
    details = 'Cash deposit into ' + account.name + '.';
  } else {
    details = 'Cash withdrawal from ' + account.name + '.';
  }
  current.confirmation = data;
  el('review-total').textContent = amount;
  el('review-note').textContent = details;
  el('review').hidden = false;
  el('submit').textContent = 'Confirm ' + labels[action].toLowerCase();
  current.focus = 'submit';
  notice();
}

async function submit(current) {
  const action = current.action;
  const data = current.confirmation;
  notice('Submitting ' + labels[action].toLowerCase() + '…');
  await call(action, data);
  if (session !== current) return;
  setAction(null);
  current.statement = null;
  current.stale = true;
  renderActivity();
  const success = labels[action] + ' complete.';
  notice(success + ' Updating balances…', 'success');
  try {
    const snapshot = await call('getBankSnapshot', { accountId: data.accountId });
    if (session !== current) return;
    current.snapshot = snapshot;
    current.stale = false;
    renderSnapshot();
    notice(success, 'success');
  } catch {
    if (session === current) notice(success + ' Select Refresh balances to update the display.', 'success');
  }
  current.focus = 'bank';
}

function hide() {
  closeDropdown(false);
  closePinPad(false);
  setController(false);
  session = null;
  bank.hidden = true;
  el('account').replaceChildren();
  el('entries').replaceChildren();
  for (const id of ['customer', 'balance', 'number', 'cash', 'review-total', 'review-note']) el(id).textContent = '';
  el('move').reset();
  el('card-pin').value = '';
  el('card-list').replaceChildren();
  el('card-select').replaceChildren();
}

async function close() {
  const current = session;
  if (!current || current.busy || current.closing) return;
  current.closing = true;
  updateControls();
  try {
    await call('close');
    if (session === current) hide();
  } catch (error) {
    if (session !== current) return;
    current.closing = false;
    updateControls();
    notice(error.message, 'error');
  }
}

async function open(event) {
  if (!event || event.type !== 'bank:open' || !event.snapshot || event.generation <= latestGeneration) return;
  latestGeneration = event.generation;
  const snapshot = event.snapshot;
  snapshot.accounts = Array.isArray(snapshot.accounts) ? snapshot.accounts : [];
  snapshot.recent = Array.isArray(snapshot.recent) ? snapshot.recent : [];
  const current = { snapshot, action: null, statement: null, busy: true, stale: false };
  session = current;
  notice();
  theme(snapshot.theme);
  setAction(null);
  renderSnapshot();
  bank.hidden = false;
  try {
    const rendered = await call('rendered', { generation: event.generation });
    if (session !== current) return;
    current.busy = false;
    updateControls();
    setController(rendered?.pad === true);
    if (!controllerActive) bank.focus({ preventScroll: true });
  } catch {
    if (session === current) hide();
  }
}

el('card-form').addEventListener('submit', event => {
  event.preventDefault();
  run(async current => {
    const pin = el('card-pin').value;
    el('card-pin').value = '';
    if (!/^[0-9]{4}$/.test(pin)) throw new Error('Enter a four-digit PIN.');
    const atm = current.snapshot.mode === 'atm';
    const cardId = el('card-select').value;
    const accountId = selected().id;
    if (!atm && current.cardRequest?.accountId !== accountId) {
      current.cardRequest = { accountId, requestId: crypto.randomUUID() };
    }
    await call(atm ? 'unlockCard' : 'issueCard', { accountId, cardId, pin, requestId: current.cardRequest?.requestId });
    current.cardRequest = null;
    if (session !== current) return;
    notice(atm ? 'Card verified. Refreshing account…' : 'Debit card issued. Refreshing cards…', 'success');
    await reloadCards(current, atm ? 'Card verified.' : 'Debit card issued to your inventory.');
  });
});
el('card-list').addEventListener('click', event => {
  const button = event.target.closest('[data-card-action]');
  if (!button) return;
  run(async current => {
    await call('manageCard', { accountId: selected().id, cardId: button.dataset.card, action: button.dataset.cardAction });
    if (session !== current) return;
    await reloadCards(current, 'Card updated.');
  });
});
el('accounts-nav').addEventListener('click', () => {
  session.management = true;
  session.statement = null;
  el('account-form').hidden = false;
  renderActivity();
  focusControl(el('account-name'));
});
el('new-account').addEventListener('click', () => {
  session.management = true;
  session.statement = null;
  renderActivity();
  el('account-form').hidden = false;
  el('account-name').focus();
});
el('cancel-account').addEventListener('click', () => {
  el('account-form').hidden = true;
  el('accounts-nav').focus();
});
el('account-form').addEventListener('submit', event => {
  event.preventDefault();
  run(async current => {
    notice('Creating account…');
    const result = await call('createAccount', {
      label: el('account-name').value.trim(),
      kind: el('account-kind').value,
    });
    if (session !== current) return;
    el('account-form').hidden = true;
    current.stale = true;
    setAction(null);
    try {
      current.snapshot = await call('getBankSnapshot', { accountId: result.accountId });
      if (session !== current) return;
      current.statement = null;
      current.stale = false;
      renderSnapshot();
      notice('Account created.', 'success');
    } catch {
      notice('Account created. Refresh balances to load your account list.', 'success');
    }
  });
});
el('close').addEventListener('click', close);
el('refresh').addEventListener('click', () => refresh());
el('account').addEventListener('change', event => refresh(event.target.value));
function showOverview() {
  if (!session.statement && !session.management) return;
  session.management = false;
  notice();
  session.statement = null;
  renderActivity();
  updateControls();
}
el('overview-nav').addEventListener('click', showOverview);
el('transactions-nav').addEventListener('click', () => {
  if (!session.statement) openStatement(1);
});
el('statement').addEventListener('click', () => {
  if (session.statement) showOverview();
  else openStatement(1);
});
el('previous').addEventListener('click', () => openStatement(session.statement.page - 1));
el('next').addEventListener('click', () => openStatement(session.statement.page + 1));
el('actions').addEventListener('click', event => {
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (!action || session.busy) return;
  notice();
  setAction(action, true);
  if (action === 'deposit' || action === 'withdraw') {
    const current = session;
    editInput(el('amount'), true).then(committed => {
      if (committed && session === current && current.action === action) el('move').requestSubmit();
    });
  }
});
function cancel() {
  const button = actions.find(item => item.dataset.action === session.action);
  setAction(null);
  notice();
  button?.focus();
}
el('cancel').addEventListener('click', cancel);
el('quick-cash').addEventListener('click', event => {
  const preset = event.target.closest('[data-amount]');
  if (!preset || !session || session.busy || session.confirmation) return;
  el('amount').value = preset.dataset.amount;
  el('move').requestSubmit();
});
el('move').addEventListener('submit', event => {
  event.preventDefault();
  run(current => current.confirmation ? submit(current) : buildConfirmation(current));
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && previewSequence !== null) { event.preventDefault(); closeCardPreview(); return; }
  if (event.key !== 'Escape' || !session || event.repeat) return;
  event.preventDefault();
  if (session.busy || session.closing) return;
  goBack();
});
window.addEventListener('message', event => {
  if (event.data?.type === 'card:open') return showCardPreview(event.data);
  if (event.data?.type === 'card:close') return hideCardPreview();
  if (event.data?.action === 'padDevice' && previewSequence !== null) return;
  if (event.data?.action === 'padDevice') return setController(event.data.pad === true);
  if (event.data?.action === 'pad') return onPad(event.data);
  if (event.data?.type === 'bank:close') hide();
  else open(event.data).catch(report);
});


function availableControls() {
  const root = dropdownSelect ? el('controller-dropdown') : el('pin-pad').hidden ? bank : el('pin-pad');
  return [...root.querySelectorAll('button, input, select')].filter(node =>
    !node.disabled && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden');
}

function focusControl(node) {
  if (!node) return;
  node.focus({ preventScroll: true });
  node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  updateFocusMarker();
}

function ensurePadFocus() {
  const controls = availableControls();
  if (!controls.includes(document.activeElement)) {
    focusControl(controls.find(node => node.id === 'account') || controls[0]);
  }
}

function setController(on) {
  controllerActive = on;
  bank.classList.toggle('controller-active', on);
  el('pad-hints').hidden = !on;
  if (on && session) ensurePadFocus();
  updateFocusMarker();
}

function goBack() {
  if (dropdownSelect) return closeDropdown(false);
  if (!el('pin-pad').hidden) return closePinPad(false);
  if (session?.busy || editingField) return;
  if (!el('account-form').hidden) {
    el('account-form').hidden = true;
    return focusControl(el('accounts-nav'));
  }
  if (session?.action) return cancel();
  if (session?.statement || session?.management) {
    showOverview();
    return focusControl(el('overview-nav'));
  }
  close();
}

function stepSelect(select, direction) {
  if (select.disabled || !select.options.length) return;
  const next = Math.max(0, Math.min(select.options.length - 1, select.selectedIndex + direction));
  if (next === select.selectedIndex) return;
  select.selectedIndex = next;
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

function moveFocus(direction) {
  ensurePadFocus();
  const current = document.activeElement;
  const start = current.getBoundingClientRect();
  const sx = start.left + start.width / 2;
  const sy = start.top + start.height / 2;
  const vertical = direction === 'up' || direction === 'down';
  const sign = direction === 'up' || direction === 'left' ? -1 : 1;
  const candidates = availableControls().filter(node => node !== current).map(node => {
    const box = node.getBoundingClientRect();
    const dx = box.left + box.width / 2 - sx;
    const dy = box.top + box.height / 2 - sy;
    const forward = (vertical ? dy : dx) * sign;
    const cross = Math.abs(vertical ? dx : dy);
    return { node, forward, score: forward + cross * 3 };
  }).filter(item => item.forward > 4).sort((a, b) => a.score - b.score);
  focusControl(candidates[0]?.node);
}

function updateFocusMarker() {
  const marker = el('controller-focus');
  const node = document.activeElement;
  const visible = controllerActive && session && !bank.hidden && !editingField
    && node !== bank && bank.contains(node) && node.getClientRects().length > 0;
  marker.hidden = !visible;
  if (!visible) return;
  const box = node.getBoundingClientRect();
  marker.style.left = box.left - 4 + 'px';
  marker.style.top = box.top - 4 + 'px';
  marker.style.width = box.width + 8 + 'px';
  marker.style.height = box.height + 8 + 'px';
}
document.addEventListener('focusin', updateFocusMarker);
document.addEventListener('scroll', updateFocusMarker, true);
window.addEventListener('resize', updateFocusMarker);

function highlightDropdown() {
  for (const button of el('dropdown-options').children) {
    const active = Number(button.dataset.index) === dropdownIndex;
    button.setAttribute('aria-selected', String(active));
    if (active) focusControl(button);
  }
}
function openDropdown(select) {
  if (select.disabled || !select.options.length) return;
  dropdownSelect = select;
  dropdownIndex = select.selectedIndex;
  const label = document.querySelector('label[for="' + select.id + '"]');
  el('dropdown-title').textContent = label?.textContent || 'Select an option';
  el('dropdown-options').replaceChildren(...[...select.options].filter(option => !option.disabled).map(option => {
    const button = document.createElement('button');
    button.type = 'button';
    button.role = 'option';
    button.dataset.index = option.index;
    button.textContent = option.textContent;
    button.addEventListener('click', () => { dropdownIndex = option.index; closeDropdown(true); });
    return button;
  }));
  select.setAttribute('aria-expanded', 'true');
  el('controller-dropdown').hidden = false;
  const panel = el('controller-dropdown').firstElementChild;
  const rect = select.getBoundingClientRect();
  const width = Math.min(Math.max(rect.width, 280), window.innerWidth - 32);
  panel.style.width = width + 'px';
  panel.style.left = Math.min(Math.max(16, rect.left), window.innerWidth - width - 16) + 'px';
  const height = panel.getBoundingClientRect().height;
  const top = rect.bottom + 8 + height <= window.innerHeight - 16 ? rect.bottom + 8 : rect.top - height - 8;
  panel.style.top = Math.max(16, Math.min(top, window.innerHeight - height - 16)) + 'px';
  highlightDropdown();
}
function closeDropdown(commit) {
  if (!dropdownSelect) return;
  const select = dropdownSelect;
  dropdownSelect = null;
  el('controller-dropdown').hidden = true;
  select.setAttribute('aria-expanded', 'false');
  if (commit && select.selectedIndex !== dropdownIndex) {
    select.selectedIndex = dropdownIndex;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }
  if (session) focusControl(select);
}

function refreshPinPad() {
  el('pin-display').textContent = '●'.repeat(pinDraft.length) + '○'.repeat(4 - pinDraft.length);
  el('pin-done').disabled = pinDraft.length !== 4;
}

function openPinPad(input) {
  pinReturn = input;
  pinDraft = '';
  el('pin-pad').hidden = false;
  refreshPinPad();
  focusControl(el('pin-pad').querySelector('[data-digit="7"]'));
}

function closePinPad(commit) {
  if (el('pin-pad').hidden) return;
  if (commit && pinDraft.length !== 4) return;
  if (commit && pinReturn) {
    pinReturn.value = pinDraft;
    pinReturn.dispatchEvent(new Event('input', { bubbles: true }));
  }
  pinDraft = '';
  el('pin-display').textContent = '';
  el('pin-pad').hidden = true;
  const restore = pinReturn;
  pinReturn = null;
  if (session) focusControl(restore);
}

async function editInput(input, automatic = false) {
  if (input.id === 'card-pin') return openPinPad(input);
  const current = session;
  editingField = true;
  try {
    const result = await call('editField', {
      field: input.id, value: input.value, action: session.action,
      accountName: selected()?.name, auto: automatic
    });
    if (session === current && result && !result.cancelled) {
      input.value = result.value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
  } catch (error) {
    if (session === current) notice(error.message, 'error');
  } finally {
    editingField = false;
    if (session === current) focusControl(input);
  }
}

function onPad(event) {
  if (previewSequence !== null) {
    if (event.down !== false && (event.cmd === 'b' || event.cmd === 'a')) closeCardPreview();
    return;
  }
  if (!session || bank.hidden || event.down === false) return;
  setController(true);
  if (editingField || session.busy || session.closing) return;
  if (dropdownSelect) {
    if (event.cmd === 'b') return closeDropdown(false);
    if (event.cmd === 'a') return closeDropdown(true);
    if (event.cmd === 'up' || event.cmd === 'down') {
      const options = [...dropdownSelect.options].filter(option => !option.disabled);
      const change = event.cmd === 'up' ? -1 : 1;
      const active = options.findIndex(option => option.index === dropdownIndex);
      dropdownIndex = options[Math.max(0, Math.min(options.length - 1, active + change))]?.index ?? dropdownIndex;
      highlightDropdown();
    }
    return;
  }
  if (event.cmd === 'b') return goBack();
  if (['up', 'down', 'left', 'right'].includes(event.cmd)) return moveFocus(event.cmd);
  if (!el('pin-pad').hidden) {
    if (event.cmd === 'x') return el('pin-delete').click();
    if (event.cmd === 'rb' && !el('pin-done').disabled) return el('pin-done').click();
    if (event.cmd === 'a') document.activeElement?.click();
    return;
  }
  if (event.cmd === 'lb' || event.cmd === 'rb') {
    return openDropdown(el('account'));
  }
  if (event.cmd === 'x') {
    if (!el('refresh').disabled) refresh();
    return;
  }
  if (event.cmd !== 'a') return;
  ensurePadFocus();
  const node = document.activeElement;
  if (node.tagName === 'INPUT') editInput(node);
  else if (node.tagName === 'SELECT') openDropdown(node);
  else node.click();
}

el('pin-pad').addEventListener('click', event => {
  const digit = event.target.closest('[data-digit]')?.dataset.digit;
  if (digit && pinDraft.length < 4) {
    pinDraft += digit;
    refreshPinPad();
  }
});
el('amount').addEventListener('click', () => { if (session && !editingField && !session.busy) editInput(el('amount')); });
el('card-pin').addEventListener('click', () => { if (session && !session.busy) openPinPad(el('card-pin')); });
el('pin-delete').addEventListener('click', () => {
  pinDraft = pinDraft.slice(0, -1);
  refreshPinPad();
});
el('pin-done').addEventListener('click', () => closePinPad(true));
el('pin-cancel').addEventListener('click', () => closePinPad(false));
new MutationObserver(() => {
  if (controllerActive && session && !bank.hidden && !editingField) ensurePadFocus();
}).observe(bank, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'disabled'] });

function hideCardPreview() {
  previewSequence = null;
  el('card-preview').hidden = true;
  for (const id of ['preview-holder', 'preview-account-name', 'preview-account-number', 'preview-card-status', 'preview-last-four', 'preview-error']) {
    el(id).textContent = '';
  }
}
async function showCardPreview(event) {
  if (session || !event.card || !Number.isInteger(event.sequence)) return;
  previewSequence = event.sequence;
  el('preview-holder').textContent = event.card.holder || 'Account holder';
  el('preview-account-name').textContent = event.card.accountName || 'Account';
  el('preview-account-number').textContent = event.card.accountNumber || '';
  el('preview-card-status').textContent = event.card.status ? event.card.status[0].toUpperCase() + event.card.status.slice(1) : 'Unavailable';
  el('preview-card-status').dataset.status = event.card.status;
  el('preview-last-four').textContent = 'Card · ' + (event.card.lastFour || '');
  el('preview-error').textContent = '';
  el('card-preview').hidden = false;
  try {
    await call('cardReady', { sequence: event.sequence });
    if (previewSequence === event.sequence) el('card-preview-close').focus();
  } catch {
    if (previewSequence === event.sequence) hideCardPreview();
  }
}
async function closeCardPreview() {
  const sequence = previewSequence;
  try { await call('cardClose'); if (sequence === previewSequence) hideCardPreview(); }
  catch { el('preview-error').textContent = 'Could not close the card. Try again.'; }
}
el('card-preview-close').addEventListener('click', closeCardPreview);

function report(error) {
  call('uiError', { message: String(error).slice(0, 400) }).catch(() => {});
}
window.addEventListener('error', event => report(event.message));
call('ready').then(event => event?.type === 'card:open' ? showCardPreview(event) : open(event)).catch(report);


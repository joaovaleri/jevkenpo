const $ = id => document.getElementById(id);
const ui = Object.fromEntries(['best', 'round', 'emoji', 'hero-object', 'object-name', 'current-name', 'tagline', 'guess-form', 'guess', 'submit', 'input-hint', 'feedback', 'end-actions', 'journey', 'chain-count', 'chain', 'share', 'restart', 'retry-connection'].map(id => [id, $(id)]));
let game;
let busy = false;
let best = 0;
let savedToken = null;
try { savedToken = localStorage.getItem('jevkenpo-run'); } catch { /* Storage may be disabled. */ }
try { best = Math.max(0, Math.min(499, Number(localStorage.getItem('jevkenpo-best')) || 0)); } catch { /* Storage may be disabled. */ }
ui.best.textContent = best;

function feedback(message, type = '') {
  ui.feedback.textContent = message;
  ui.feedback.className = `feedback ${type}`;
}

function setBusy(value) {
  busy = value;
  ui['guess-form'].classList.toggle('is-loading', busy);
  ui.guess.disabled = busy || !game?.available || game?.over;
  ui.submit.disabled = ui.guess.disabled || !ui.guess.value.trim();
  ui.restart.disabled = busy;
  $('play-again').disabled = busy;
  $('confirm-restart').disabled = busy;
  ui['guess-form'].setAttribute('aria-busy', String(busy));
}

function render(animate = false) {
  const current = game.history.at(-1);
  ui.emoji.textContent = current.emoji;
  ui.emoji.setAttribute('aria-label', current.name);
  ui['object-name'].textContent = current.name;
  ui['current-name'].textContent = current.name;
  ui.round.textContent = game.over ? 'EVERY GOOD CHAIN HAS AN END' : game.score ? `${game.score} ${game.score === 1 ? 'THING' : 'THINGS'} BEATEN. KEEP GOING.` : 'THE POSSIBILITIES ARE ENDLESS';
  ui.tagline.textContent = game.over ? `You beat ${game.score} ${game.score === 1 ? 'thing' : 'things'}. How about one more run?` : 'Rock, paper, scissors. And literally anything else.';
  ui.guess.placeholder = game.score ? 'Think outside the universe…' : 'A black hole, maybe?';
  ui['guess-form'].hidden = game.over;
  ui['input-hint'].hidden = game.over;
  ui['end-actions'].hidden = !game.over;
  document.querySelector('.game').classList.toggle('is-over', game.over);
  ui.journey.hidden = !game.score && !game.over;
  ui.restart.hidden = game.over;
  ui['chain-count'].textContent = String(game.score).padStart(2, '0');
  ui.chain.replaceChildren(...game.history.map(item => {
    const li = document.createElement('li');
    const chip = document.createElement('span');
    chip.className = 'chain-piece';
    chip.title = item.name;
    const emoji = document.createElement('span');
    emoji.textContent = item.emoji;
    emoji.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.textContent = item.name;
    chip.append(emoji, text);
    li.append(chip);
    return li;
  }));
  if (game.score > best) {
    best = game.score;
    ui.best.textContent = best;
    try { localStorage.setItem('jevkenpo-best', String(best)); } catch { /* Best still works for this visit. */ }
  }
  if (animate) {
    ui['hero-object'].classList.remove('pop');
    void ui['hero-object'].offsetWidth;
    ui['hero-object'].classList.add('pop');
    ui.chain.lastElementChild?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  setBusy(busy);
}

async function api(path, body) {
  const token = game?.token || savedToken;
  const payload = body || (path === '/api/game' && token ? {} : null);
  const response = await fetch(path, {
    method: payload ? 'POST' : 'GET',
    ...(payload ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, ...(token ? { token } : {}) }) } : {}),
    signal: AbortSignal.timeout(22000),
  });
  const data = await response.json();
  if (!response.ok) {
    if (data.reset) {
      savedToken = null;
      if (game) game.token = null;
      try { localStorage.removeItem('jevkenpo-run'); } catch { /* Storage may be disabled. */ }
      if (path === '/api/game') return api('/api/game');
    }
    if (data.game) { game = data.game; render(); }
    throw new Error(data.error || 'Could not connect. Try again.');
  }
  if (data.token) {
    savedToken = data.token;
    try { localStorage.setItem('jevkenpo-run', data.token); } catch { /* Current visit still works. */ }
  }
  return data;
}

function describeResult(result) {
  if (result.verdict === 'win') feedback(`${result.guess} beats ${result.against}. Jev approves.`, 'success');
  if (result.verdict === 'lose') feedback(`Jev says ${result.guess} doesn’t beat ${result.against}.`, 'error');
  if (result.verdict === 'repeat') feedback('Already in your chain. Think of something new.', 'error');
  if (result.verdict === 'invalid') feedback('Name a thing or an idea. Let Jev do the judging.', 'error');
  const probability = result.winProbability;
  if (Number.isFinite(probability) && probability >= 0 && probability <= 1) {
    const chance = document.createElement('span');
    chance.className = 'win-probability';
    const value = document.createElement('strong');
    value.textContent = probability > 0 && probability < 0.001 ? '<0.1%'
      : probability < 1 && probability > 0.999 ? '>99.9%'
      : new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 }).format(probability);
    chance.append('Jev’s win probability: ', value);
    ui.feedback.append(chance);
  }
}

async function connect() {
  setBusy(true);
  ui['retry-connection'].hidden = true;
  try {
    game = await api('/api/game');
    render();
    if (!game.available) feedback('Jev is not connected yet. Add the API key on the server to play.', 'error');
    else if (game.last) describeResult(game.last);
    else feedback('');
  } catch {
    feedback('Couldn’t reach Jev. Try connecting again.', 'error');
    ui['retry-connection'].hidden = false;
  } finally { setBusy(false); }
}

ui.guess.addEventListener('input', () => { ui.submit.disabled = busy || !ui.guess.value.trim() || !game?.available; });
ui['guess-form'].addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || !game?.available || game.over || !ui.guess.value.trim()) return;
  const guess = ui.guess.value.trim();
  setBusy(true);
  feedback('Jev is thinking it over…', 'pending');
  try {
    const next = await api('/api/guess', { guess, revision: game.revision });
    game = next;
    if (next.result.verdict === 'win') ui.guess.value = '';
    render(next.result.verdict === 'win');
    describeResult(next.result);
  } catch (error) {
    // A lost response may have reached the server. Reconcile before allowing another move.
    try { game = await api('/api/game'); render(); } catch { /* Reconnection is offered below. */ }
    if (game?.last?.guess === guess && ['win', 'lose'].includes(game.last.verdict)) {
      if (game.last.verdict === 'win') ui.guess.value = '';
      describeResult(game.last);
    } else feedback(error.name === 'TimeoutError' ? 'That took too long. Try again; your run is safe.' : error.message, 'error');
  } finally {
    setBusy(false);
    if (game.over) $('play-again').focus({ preventScroll: true });
    else ui.guess.focus({ preventScroll: true });
  }
});

async function newRun() {
  if (busy || !game) return;
  setBusy(true);
  $('restart-dialog').close();
  try {
    game = await api('/api/new', { revision: game.revision });
    ui.guess.value = '';
    render(true);
    feedback('');
  } catch (error) { feedback(error.message, 'error'); }
  finally { setBusy(false); ui.guess.focus({ preventScroll: true }); }
}

$('help').addEventListener('click', () => $('rules').showModal());
$('close-rules').addEventListener('click', () => $('rules').close());
$('got-it').addEventListener('click', () => { $('rules').close(); if (!game?.over) ui.guess.focus({ preventScroll: true }); });
ui.restart.addEventListener('click', () => $('restart-dialog').showModal());
$('close-restart').addEventListener('click', () => $('restart-dialog').close());
$('keep-playing').addEventListener('click', () => $('restart-dialog').close());
$('confirm-restart').addEventListener('click', newRun);
$('play-again').addEventListener('click', newRun);
ui['retry-connection'].addEventListener('click', connect);
for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('click', event => {
  const box = dialog.getBoundingClientRect();
  if (event.target === dialog && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)) dialog.close();
});

ui.share.addEventListener('click', async () => {
  if (!game) return;
  const short = game.history.length > 12;
  const sequence = (short ? game.history.slice(-12) : game.history).map(item => `${item.emoji} ${item.name}`).join(' → ');
  const text = `I beat ${game.score} ${game.score === 1 ? 'thing' : 'things'} in Jevkenpo.\n${short ? '… → ' : ''}${sequence}\nWhat beats that?`;
  try {
    if (navigator.share) await navigator.share({ title: 'Jevkenpo', text, url: location.origin });
    else {
      await navigator.clipboard.writeText(`${text}\n${location.origin}`);
      ui.share.textContent = 'Copied ✓';
      setTimeout(() => { ui.share.textContent = 'Share run ↗'; }, 2500);
    }
  } catch (error) {
    if (error.name !== 'AbortError') feedback('Couldn’t share automatically. You can copy the page link.', 'error');
  }
});

window.addEventListener('pageshow', event => { if (event.persisted) connect(); });
connect();

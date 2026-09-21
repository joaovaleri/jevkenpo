const $ = id => document.getElementById(id);
let key = '';
let busy = false;
const number = new Intl.NumberFormat('pt-BR');
const date = value => new Date(value).toLocaleString('pt-BR');

async function load() {
  if (busy) return;
  busy = true;
  const requestedKey = key;
  $('stats-status').textContent = 'Carregando…';
  try {
    const response = await fetch('/api/metrics', {
      headers: { Authorization: `Bearer ${requestedKey}` }, cache: 'no-store', signal: AbortSignal.timeout(12000),
    });
    const data = await response.json();
    if (key !== requestedKey) return;
    if (!response.ok) throw new Error(data.error || 'Não foi possível carregar as métricas.');
    $('visitors').textContent = number.format(data.visitors);
    $('players').textContent = number.format(data.players);
    $('conversion').textContent = data.visitors
      ? new Intl.NumberFormat('pt-BR', { style: 'percent', maximumFractionDigits: 1 }).format(data.players / data.visitors) : '—';
    $('stats-period').textContent = `${data.startedAt ? `Desde ${date(data.startedAt)}. ` : ''}Atualizado em ${date(data.updatedAt)}. Pode levar até um minuto para atualizar.`;
    $('stats-login').hidden = true;
    $('access-key').value = '';
    $('stats-results').hidden = false;
    $('stats-status').textContent = '';
  } catch (error) { if (key === requestedKey) $('stats-status').textContent = error.name === 'TimeoutError' ? 'Demorou um pouco. Tente novamente.' : error.message; }
  finally { busy = false; }
}
$('stats-login').addEventListener('submit', event => { event.preventDefault(); key = $('access-key').value.trim(); void load(); });
$('refresh').addEventListener('click', load);
$('logout').addEventListener('click', () => {
  key = '';
  for (const id of ['visitors', 'players', 'conversion']) $(id).textContent = '—';
  $('stats-period').textContent = '';
  $('stats-results').hidden = true;
  $('stats-login').hidden = false;
  $('stats-status').textContent = '';
  $('access-key').focus();
});

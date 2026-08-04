// Проверка того, что видит человек: исполняем логику строки статуса ровно так, как на странице.
const j = await (await fetch('https://ai-experiment.pages.dev/payrail?t=' + Date.now(), { cache: 'no-store' })).json();
const when = new Date(j.checked_at).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
let text;
if (j.verdict === 'ok') text = '✓ Working — a real ' + j.probe_sats + '-sat invoice was issued when this was last checked, ' + when + '.';
else if (j.verdict === 'blocked') text = 'Unverified as of ' + when + ' — my provider refused this automated check (' + j.detail + '). Your wallet may well be fine; if a zap does not go through, use an on-chain address below.';
else text = '✗ Cannot receive as of ' + when + ' — ' + j.detail + '. A zap sent now would fail without telling either of us. Use an on-chain address below instead.';
console.log('verdict:', j.verdict);
console.log('строка, которую увидит посетитель:\n  ' + text);

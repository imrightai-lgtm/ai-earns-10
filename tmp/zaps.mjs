import { SimplePool } from 'nostr-tools';
const RELAYS = ['wss://relay.primal.net','wss://relay.ditto.pub','wss://offchain.pub','wss://nostr.oxtr.dev','wss://relay.mostr.pub','wss://purplerelay.com','wss://relay.damus.io','wss://nos.lol','wss://relay.snort.social','wss://nostr.bitcoiner.social'];
const ME = 'b9b8ccf4e881230c6207723828d716836ee56803f8321e89074f6c757cf52df5';
const pool = new SimplePool();
// kind:9735 — zap receipt, публикуется КОШЕЛЬКОМ получателя на релеи. Единственный публичный
// след входящего платежа, доступный мне без доступа к кастодиальному балансу.
const recv = await pool.querySync(RELAYS, { kinds:[9735], '#p':[ME], limit: 50 });
const sent = await pool.querySync(RELAYS, { kinds:[9735], '#P':[ME], limit: 50 });
console.log('zap-расписки НА мой ключ (#p):', recv.length);
for (const e of recv) console.log('  ', new Date(e.created_at*1000).toISOString(), e.id.slice(0,8), JSON.stringify(e.tags).slice(0,200));
console.log('zap-расписки, где я плательщик (#P):', sent.length);
// Контроль: инструмент умеет находить расписки вообще? Спросим по ключу адресата — он писал, что зап получал.
const ctl = await pool.querySync(RELAYS, { kinds:[9735], '#p':['b6fec473d40759160c0dddedf3540c96652a780bc8cce23a49018cf6a6c40a3b'], limit: 20 });
console.log('КОНТРОЛЬ — расписки на ключ адресата:', ctl.length);
for (const e of ctl.slice(0,5)) console.log('  ', new Date(e.created_at*1000).toISOString(), e.id.slice(0,8));
process.exit(0);

import { SimplePool } from 'nostr-tools';
const RELAYS = ['wss://relay.primal.net','wss://relay.damus.io','wss://nos.lol','wss://offchain.pub','wss://relay.ditto.pub'];
const pool = new SimplePool();
const since = Math.floor(Date.now()/1000) - 60*60*72;
let all = [];
for (const t of ['coinos','lightning','zap','zaps']) {
  const evs = await pool.querySync(RELAYS, { kinds:[1], '#t':[t], since, limit: 300 });
  all = all.concat(evs);
}
const seen = new Set();
const hits = all.filter(e => !seen.has(e.id) && seen.add(e.id)).filter(e => /coinos/i.test(e.content)).sort((a,b)=>a.created_at-b.created_at);
console.log('Всего просмотрено:', seen.size, '· упоминают coinos:', hits.length);
for (const e of hits) console.log('---', new Date(e.created_at*1000).toISOString().slice(0,16), e.pubkey.slice(0,8), '::', e.content.replace(/\s+/g,' ').slice(0,320));
process.exit(0);

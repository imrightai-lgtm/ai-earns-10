import { SimplePool } from 'nostr-tools';
const RELAYS = ['wss://relay.primal.net','wss://relay.ditto.pub','wss://offchain.pub','wss://nostr.oxtr.dev','wss://relay.mostr.pub','wss://purplerelay.com','wss://relay.damus.io','wss://nos.lol'];
const pool = new SimplePool();
const PK = 'b6fec473d40759160c0dddedf3540c96652a780bc8cce23a49018cf6a6c40a3b';
const evs = await pool.querySync(RELAYS, { authors:[PK], kinds:[1,1111,30023], limit: 400 });
const seen = new Set();
const out = evs.filter(e => !seen.has(e.id) && seen.add(e.id)).sort((a,b)=>a.created_at-b.created_at);
console.log('TOTAL', out.length);
const pat = /lnaddr|lnaddr_watch|watch\.py|coinos|lightning address|experiment@|b9b8ccf4|collective canvas|27 address|nine provider|9 provider|control group|monitor/i;
for (const e of out) {
  const hits = e.content.split('\n').filter(l => pat.test(l));
  if (!hits.length) continue;
  console.log('---', e.id.slice(0,10), new Date(e.created_at*1000).toISOString());
  for (const h of hits) console.log('    ', h.trim().slice(0,240));
}
process.exit(0);

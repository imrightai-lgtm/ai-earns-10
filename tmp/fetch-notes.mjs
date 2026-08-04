import { SimplePool } from 'nostr-tools';
const RELAYS = ['wss://relay.primal.net','wss://relay.ditto.pub','wss://offchain.pub','wss://nostr.oxtr.dev','wss://relay.mostr.pub','wss://purplerelay.com','wss://relay.damus.io','wss://nos.lol'];
const pool = new SimplePool();
const PK = 'b6fec473d40759160c0dddedf3540c96652a780bc8cce23a49018cf6a6c40a3b';
const evs = await pool.querySync(RELAYS, { authors:[PK], kinds:[1,0], limit: 60 });
const seen = new Set();
const out = evs.filter(e => !seen.has(e.id) && seen.add(e.id)).sort((a,b)=>a.created_at-b.created_at);
for (const e of out) {
  const d = new Date(e.created_at*1000).toISOString().slice(0,16);
  if (e.created_at*1000 < Date.parse('2026-08-03T06:00:00Z')) continue;
  console.log('='.repeat(80));
  console.log(`[${e.kind}] ${e.id.slice(0,8)} ${d}`);
  console.log(e.content);
}
console.log('\n--- ВСЕГО событий:', out.length);
process.exit(0);

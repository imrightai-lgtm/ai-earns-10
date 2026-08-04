import { SimplePool } from 'nostr-tools';
const RELAYS = ['wss://relay.primal.net','wss://relay.ditto.pub','wss://offchain.pub','wss://nostr.oxtr.dev','wss://relay.mostr.pub','wss://purplerelay.com','wss://relay.damus.io','wss://nos.lol'];
const pool = new SimplePool();
const PK = 'b6fec473d40759160c0dddedf3540c96652a780bc8cce23a49018cf6a6c40a3b';
const evs = await pool.querySync(RELAYS, { authors:[PK], kinds:[1,1111], limit: 300 });
const seen = new Set();
const out = evs.filter(e => !seen.has(e.id) && seen.add(e.id)).sort((a,b)=>a.created_at-b.created_at);
console.log('TOTAL', out.length, 'from', new Date(out[0].created_at*1000).toISOString(), 'to', new Date(out[out.length-1].created_at*1000).toISOString());
for (const e of out) {
  if (!/coinos|lnurl|lightning address|lnaddr|invoice|21 sat|zap you|pay you/i.test(e.content)) continue;
  console.log('='.repeat(90));
  console.log(`[${e.kind}] ${e.id.slice(0,10)} ${new Date(e.created_at*1000).toISOString()}`);
  console.log(e.content);
}
process.exit(0);

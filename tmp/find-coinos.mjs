import { SimplePool } from 'nostr-tools';
const RELAYS = ['wss://relay.primal.net','wss://relay.damus.io','wss://nos.lol','wss://offchain.pub'];
const pool = new SimplePool();
const evs = await pool.querySync(RELAYS, { kinds:[0], limit: 500 });
const hits = [];
for (const e of evs) {
  try { const j = JSON.parse(e.content); if (j.lud16 && /@coinos\.io$/i.test(j.lud16)) hits.push(j.lud16.toLowerCase()); } catch {}
}
console.log('kind:0 просмотрено:', evs.length, '· coinos-адресов:', [...new Set(hits)].length);
console.log([...new Set(hits)].slice(0,12).join('\n'));
process.exit(0);

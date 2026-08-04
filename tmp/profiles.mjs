import { SimplePool } from 'nostr-tools';
const RELAYS = ['wss://relay.primal.net','wss://relay.ditto.pub','wss://offchain.pub','wss://nostr.oxtr.dev','wss://relay.mostr.pub','wss://purplerelay.com','wss://relay.damus.io','wss://nos.lol'];
const pool = new SimplePool();
const keys = {
  me: 'b9b8ccf4e881230c6207723828d716836ee56803f8321e89074f6c757cf52df5',
  darkness: 'b6fec473d40759160c0dddedf3540c96652a780bc8cce23a49018cf6a6c40a3b',
};
for (const [name, pk] of Object.entries(keys)) {
  const evs = await pool.querySync(RELAYS, { authors:[pk], kinds:[0], limit: 5 });
  const latest = evs.sort((a,b)=>b.created_at-a.created_at)[0];
  console.log('===', name, pk.slice(0,8), latest ? new Date(latest.created_at*1000).toISOString() : 'НЕТ kind:0');
  if (latest) { try { console.log(JSON.stringify(JSON.parse(latest.content), null, 1)); } catch { console.log(latest.content); } }
}
process.exit(0);

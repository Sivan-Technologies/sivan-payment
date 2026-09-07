import pg from 'pg';
import { env } from '../src/config/env.js';

const { Client } = pg;

async function main() {
  const targetNetwork = (process.argv[2] || 'stellar').toLowerCase();
  console.log(`\n==================================================`);
  console.log(`🔄 DIRECT SQL SWITCH: DEFAULT NETWORK → ${targetNetwork.toUpperCase()}`);
  console.log(`==================================================\n`);

  const client = new Client({ connectionString: env.DATABASE_URL });
  await client.connect();

  try {
    // 1. Check current table state
    const currentRes = await client.query('select network, enabled, is_default, label, sort_order from payments_network_controls order by sort_order asc');
    console.log('Current DB Rows:');
    for (const r of currentRes.rows) {
      console.log(`  - ${r.label} (${r.network}): enabled=${r.enabled}, isDefault=${r.is_default}`);
    }

    // 2. Set all to false, target to true
    await client.query('begin');
    await client.query('update payments_network_controls set is_default = false');
    const updateRes = await client.query('update payments_network_controls set is_default = true where lower(network) = $1 returning *', [targetNetwork]);
    
    if (updateRes.rowCount === 0) {
      // If row did not exist, insert it
      await client.query(
        `insert into payments_network_controls (network, enabled, is_default, label, sort_order, updated_at)
         values ($1, true, true, $2, 25, now())`,
        [targetNetwork, targetNetwork.charAt(0).toUpperCase() + targetNetwork.slice(1)]
      );
    }
    await client.query('commit');
    console.log(`\n✅ Successfully switched default network to: ${targetNetwork.toUpperCase()}`);

    // 3. Verify
    const verifyRes = await client.query('select network, enabled, is_default, label, sort_order from payments_network_controls order by sort_order asc');
    console.log('\nUpdated DB Rows:');
    for (const r of verifyRes.rows) {
      const defaultTag = r.is_default ? ' [ACTIVE DEFAULT ★]' : '';
      console.log(`  - ${r.label} (${r.network}): enabled=${r.enabled}, isDefault=${r.is_default}${defaultTag}`);
    }
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('Failed to switch default network:', err);
  process.exit(1);
});

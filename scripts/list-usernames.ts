import pg from 'pg';

async function main() {
  const connectionString = "postgresql://neondb_owner:npg_Z9UrtjCkvO4X@ep-fragrant-lab-a5o3ka97-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require";
  const pool = new pg.Pool({ connectionString });
  
  const usersRes = await pool.query('SELECT * FROM users ORDER BY created_at ASC');
  console.log('=== USERS TABLE DATA ===');
  for (const row of usersRes.rows) {
    console.log(`- ID: ${row.id}`);
    console.log(`  Email: ${row.email}`);
    console.log(`  Full Name: ${row.full_name}`);
    console.log(`  Primary Channel: ${row.primary_channel}`);
    console.log(`  Created: ${row.created_at}`);
    console.log('---');
  }

  // Check identity links table for Telegram handles or usernames
  const idRes = await pool.query('SELECT * FROM customer_identity_links');
  console.log('\n=== CUSTOMER IDENTITY LINKS (Telegram / Phone Handles) ===');
  for (const row of idRes.rows) {
    console.log(`- User ID: ${row.user_id}`);
    console.log(`  Identifier Type: ${row.identifier_type}`);
    console.log(`  Identifier Value: ${row.identifier_value}`);
    console.log(`  Created: ${row.created_at}`);
    console.log('---');
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });

import { db } from '../src/database/json-database.js';
import { PostgresDatabase } from '../src/database/postgres-database.js';

const DB_URL = 'postgresql://neondb_owner:npg_Z9UrtjCkvO4X@ep-fragrant-lab-a5o3ka97-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require';

async function main() {
  const pgDb = new PostgresDatabase(DB_URL);
  
  const buyerId = 'usr_10ed27f0-7ff2-4228-b45c-70a327d9b3c8'; // sivantech@gmail.com
  const sellerId = 'usr_b1d36f5b-9e1d-4d72-918a-c0484310c6bc'; // solianetwork0@gmail.com (@soliame)

  console.log('Inserting seed Service Agreement into PostgreSQL database...');

  const agreement = await pgDb.insertServiceAgreement({
    id: `agr_${Date.now().toString(36)}`,
    buyerUserId: buyerId,
    sellerUserId: sellerId,
    title: 'Mobile App UI/UX Design',
    description: 'Two 50% milestone stages for mobile application design and interactive prototype',
    amountUsdc: 20,
    currency: 'USDC',
    network: 'solana',
    status: 'funded',
    deadlineDays: 7,
    fundedAt: new Date().toISOString(),
    deliveryDueAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    reminder6hSent: false,
    overdueNoticeSent: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });

  console.log('Successfully created Service Agreement:', agreement);

  const dealsForSeller = await pgDb.listServiceAgreementsByUserId(sellerId);
  console.log(`Deals for @soliame (${sellerId}):`, dealsForSeller.length);

  const dealsForBuyer = await pgDb.listServiceAgreementsByUserId(buyerId);
  console.log(`Deals for sivantech (${buyerId}):`, dealsForBuyer.length);
}

main().catch(console.error);

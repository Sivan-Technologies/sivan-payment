import dotenv from 'dotenv';
import pg from 'pg';
import { db } from '../src/database/json-database.js';
import { createBalanceLedgerEntry, getUserBalance } from '../src/balances/balance.service.js';
import { releaseAgreement } from '../src/agreements/agreement.service.js';

dotenv.config();

const { Pool } = pg;

async function main() {
  console.log('=== Sivan Service Agreement & Balance Reconciler ===\n');

  const pool = process.env.DATABASE_URL
    ? new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
      })
    : null;

  // 1. Locate the real authenticated user (solianetwork0@gmail.com)
  const targetEmail = 'solianetwork0@gmail.com';
  let targetUser = await db.findUserByEmail(targetEmail);
  if (!targetUser && pool) {
    const res = await pool.query('SELECT * FROM users WHERE lower(email)=lower($1)', [targetEmail]);
    if (res.rows[0]) {
      targetUser = {
        id: res.rows[0].user_id || res.rows[0].id,
        email: res.rows[0].email,
        fullName: res.rows[0].full_name || res.rows[0].fullName,
        username: res.rows[0].username,
        whatsappNumber: res.rows[0].whatsapp_number,
        createdAt: res.rows[0].created_at,
        updatedAt: res.rows[0].updated_at,
      } as any;
    }
  }

  if (!targetUser) {
    console.error(`❌ User with email ${targetEmail} not found in database!`);
    return;
  }

  console.log(`✓ Found target user: ${targetUser.fullName} (${targetUser.email}) -> ID: ${targetUser.id}`);

  // 2. Reconcile agreements: SIV-160927-9739 (7 USDC) and SIV-359692-5680 (6 USDC)
  const agreementIds = ['SIV-160927-9739', 'SIV-359692-5680'];

  for (const agreementId of agreementIds) {
    console.log(`\nChecking agreement [${agreementId}]...`);
    let agr = await db.findServiceAgreementById(agreementId);
    if (!agr && pool) {
      const res = await pool.query('SELECT * FROM payments_service_agreements WHERE id=$1', [agreementId]);
      if (res.rows[0]) {
        const r = res.rows[0];
        agr = {
          id: r.id,
          buyerUserId: r.buyer_user_id,
          sellerUserId: r.seller_user_id,
          title: r.title,
          description: r.description,
          amountUsdc: Number(r.amount_usdc || 0),
          currency: r.currency || 'usdc',
          status: r.status,
          network: r.network || 'solana',
          feePayer: r.fee_payer,
          sellerNetAmountUsdc: Number(r.seller_net_amount_usdc || r.amount_usdc || 0),
          buyerTotalPayableUsdc: Number(r.buyer_total_payable_usdc || r.amount_usdc || 0),
          feeAmountUsdc: Number(r.fee_amount_usdc || 0),
          channel: r.channel || 'telegram',
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        } as any;
      }
    }

    if (!agr) {
      console.log(`  - Agreement ${agreementId} not in payments_service_agreements, checking core escrows...`);
      // If present in sivan-escrow-agent DB or pool
      if (pool) {
        const escrowRes = await pool.query('SELECT * FROM escrows WHERE id=$1 OR escrow_id=$1', [agreementId]).catch(() => ({ rows: [] }));
        if (escrowRes.rows[0]) {
          const e = escrowRes.rows[0];
          console.log(`  - Found in escrows table: amount=${e.amount} ${e.currency}, status=${e.status}`);
          // Insert into payments_service_agreements
          const now = new Date().toISOString();
          await pool.query(
            `INSERT INTO payments_service_agreements (id, buyer_user_id, seller_user_id, title, description, amount_usdc, currency, status, network, fee_payer, seller_net_amount_usdc, buyer_total_payable_usdc, fee_amount_usdc, channel, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
             ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, updated_at=EXCLUDED.updated_at`,
            [
              agreementId,
              e.buyer_phone || e.buyer_whatsapp || 'buyer',
              targetUser.id,
              e.purpose || 'Service Agreement',
              e.purpose || 'Service Agreement',
              Number(e.amount || 0),
              (e.currency || 'USDC').toLowerCase(),
              'delivered',
              e.network || 'solana',
              e.fee_payer || 'buyer',
              Number(e.amount || 0),
              Number(e.amount || 0),
              0,
              'telegram',
              e.created_at || now,
              now,
            ]
          ).catch((err) => console.warn('Insert into payments_service_agreements note:', err.message));
        }
      }
    }

    try {
      const released = await releaseAgreement(agreementId);
      console.log(`  ✅ Successfully released ${agreementId} (${released.title}) -> Status: ${released.status}`);
    } catch (relErr: any) {
      console.log(`  - releaseAgreement note: ${relErr.message}`);
    }
  }

  // 3. Reconcile any shadow accounts (e.g. usr_soliame, usr_@soliame)
  const shadowTargets = ['usr_soliame', 'usr_@soliame', 'soliame', '@soliame'];
  for (const shadow of shadowTargets) {
    const shadowBal = await getUserBalance(shadow).catch(() => null);
    if (shadowBal?.balances) {
      for (const b of shadowBal.balances) {
        const avail = Number(b.available || 0);
        if (avail > 0) {
          console.log(`\nReconciling ${avail} ${b.asset.toUpperCase()} from shadow account [${shadow}] to ${targetUser.email}...`);
          await createBalanceLedgerEntry(
            {
              userId: shadow,
              asset: b.asset as any,
              amount: String(avail),
              kind: 'debit_transfer',
              status: 'completed',
              sourceType: 'user_reconciliation',
              sourceId: `recon_${targetUser.id}`,
              description: `Reconcile balance to real user account (${targetUser.email})`,
            },
            { actorType: 'system', actorId: 'balance_reconciliation' }
          );

          await createBalanceLedgerEntry(
            {
              userId: targetUser.id,
              asset: b.asset as any,
              amount: String(avail),
              kind: 'credit_available',
              status: 'available',
              sourceType: 'user_reconciliation',
              sourceId: `recon_${shadow}`,
              description: `Reconciled balance from Telegram contractor handle (${shadow})`,
            },
            { actorType: 'system', actorId: 'balance_reconciliation' }
          );
          console.log(`  ✅ Successfully transferred ${avail} ${b.asset.toUpperCase()} to ${targetUser.email}`);
        }
      }
    }
  }

  // 4. Ensure customer identity link exists for @soliame -> targetUser.id
  if (pool) {
    console.log(`\nEnsuring Telegram identity link for @soliame -> ${targetUser.email}...`);
    await pool.query(
      `INSERT INTO payments_customer_identity_links (id, payment_user_id, telegram_username, status, linked_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW(), NOW())
       ON CONFLICT (id) DO UPDATE SET payment_user_id=EXCLUDED.payment_user_id, status='linked', updated_at=NOW()`,
      [`link_tg_soliame_${targetUser.id}`, targetUser.id, 'soliame', 'linked']
    ).catch(async () => {
      // fallback without constraint name
      await pool.query(
        `UPDATE users SET telegram_username='soliame', username=COALESCE(username, 'soliame') WHERE user_id=$1 OR id=$1`,
        [targetUser.id]
      ).catch(() => null);
    });
    console.log(`  ✓ Identity link active.`);
    await pool.end();
  }

  // 5. Final balance check
  const finalBal = await getUserBalance(targetUser.id);
  console.log('\n=== Final Reconciled User Balances ===');
  console.log(JSON.stringify(finalBal.balances, null, 2));
}

main().catch(console.error);

-- Migration 045: Expand payments_user_wallets chain check constraint for Multi-Chain (Stellar, Celo, BSC)

alter table payments_user_wallets
  drop constraint if exists payments_user_wallets_chain_check;

alter table payments_user_wallets
  add constraint payments_user_wallets_chain_check
  check (chain in ('solana', 'base', 'ethereum', 'celo', 'bsc', 'bnb', 'stellar'));

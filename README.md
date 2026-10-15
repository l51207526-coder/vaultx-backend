# VaultX backend

Node.js + Express + TypeScript + Prisma/PostgreSQL API for the VaultX local development build.

## Run

1. Copy `.env.example` to `.env` and configure PostgreSQL.
2. Create a Resend account, verify a sending domain, and set `RESEND_API_KEY`,
   `EMAIL_FROM` (on that verified domain), and `FRONTEND_URL` in `.env`. Keep the
   API key private; do not commit `.env`.
3. Apply database migrations and generate Prisma Client:

```powershell
npx.cmd prisma migrate deploy
npm.cmd run prisma:generate
```

4. Check the TypeScript build:

```powershell
npx.cmd tsc --noEmit
```

5. Start the API:

```powershell
npm.cmd run dev
```

The API listens on `http://localhost:4000` by default.
`GET /api/health` checks that the API process is responding; `GET /api/ready`
also checks that PostgreSQL is reachable.
Registration, login, and password-recovery requests have per-process IP limits.
These limits are a local safeguard; a multi-instance production deployment must
also apply shared rate limits at its proxy or gateway.

## Core API

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/verify-email`
- `POST /api/auth/resend-verification`
- `POST /api/auth/forgot-password`
- `POST /api/auth/reset-password`
- `GET /api/me`
- `GET /api/wallet`
- `POST /api/wallet/deposit`
- `POST /api/wallet/withdraw`
- `GET /api/transactions`
- `GET /api/investments`
- `GET /api/investments/plans`
- `POST /api/investments`
- `GET /api/admin/pending` (development admin key)
- `POST /api/admin/deposits/:id/confirm`
- `POST /api/admin/deposits/:id/cancel`
- `POST /api/admin/withdrawals/:id/complete`
- `POST /api/admin/withdrawals/:id/reject`
- `POST /api/admin/investments/:id/mature`

## Ledger rules

Wallet balance is calculated from signed ledger entries. Deposits and investment returns create positive entries. Investment funding and completed withdrawals create negative entries. Pending requests do not change the balance.

## Per-user crypto deposit addresses

VaultX can assign accounts unique BNB Smart Chain addresses and scan transfers to those addresses. Configure `BSC_DEPOSIT_XPUB` in the backend environment with a public extended key exported at the BIP44 receiving branch `m/44'/60'/0'/0`. The backend derives non-hardened child addresses for each account and stores each assignment in `DepositAddress`. TRON address derivation is retained only for legacy records and is not used for new requests.

Only public extended keys belong in the server environment. Never put a recovery phrase or private key in `.env`, the app, or chat. An xpub cannot spend funds, but it can reveal activity for the addresses derived from it, so keep it private. Funds sent to child addresses remain there; automatic consolidation/sweeping into a treasury address is not implemented.

New address generation is disabled until the corresponding xpub is configured. Run the normal backend migration startup after updating code, then restart the backend after setting the xpubs.

## Important production limitation

The wallet is an internal application ledger, not proof that matching USDT is held for every user. Investment returns and referral credits created inside the app do not create real USDT. Tatum KMS can sign and broadcast from the separately funded payout wallet, but it cannot make an underfunded ledger safe or guarantee investment returns. Only enable real withdrawals after reconciling all user liabilities against assets actually held and reviewing applicable legal, tax, and compliance requirements.

The current VIP rates are local configured projections and must not be presented as guaranteed returns.
# Real USDT chain verification (read-only)

New deposits and withdrawals are BEP20-only. TRC20 is not offered by the customer interface or accepted for new requests. Read-only TRON settings remain available only to monitor and verify legacy TRC20 deposits that were created before this change. Use only the BNB Smart Chain address shown by the site for new USDT transfers, and never put a seed phrase or private key in this app.

The API can monitor the configured public receive addresses and automatically credit a pending deposit after a confirmed transfer matches its network and exact requested amount. When there is no unique matching request, it leaves the request pending; the user can verify it manually by entering the transaction hash. Hashes are credited at most once. The scanner starts at the current chain head when first enabled, so it does not claim old transfers against newly created requests. Withdrawal completion still requires an on-chain transfer from the configured sending address to the requested destination for the recorded net payout; send that hash as `txHash` to the admin completion endpoint. The app never signs or broadcasts transactions.

Automatic monitoring requires a read-only RPC URL, USDT contract, and public receive address for each enabled network. BNB Smart Chain uses Alchemy's public endpoint for prototyping; its scanner limits log queries to 10 blocks per request. TRON history is read from TronGrid only for legacy requests and may require `TRON_GRID_API_KEY`. The development start command applies the `ChainScanCursor` migration. Because this practice app uses a shared receive address, two pending deposits with the same network and amount are intentionally treated as ambiguous and are not auto-credited.

Important: the wallet balance is an internal practice ledger. Investment returns and referral credits created inside the app do not create real USDT. Only withdraw amounts that are actually held by the externally controlled sending address. Gas fees are paid separately by that wallet.

The BNB Smart Chain contract shown in `.env.example` is the Binance-Peg USDT token. Check the selected token and network before transferring funds.

## Tatum KMS automated BNB Smart Chain payouts

The optional worker submits BEP20 USDT payouts to Tatum using a Tatum KMS `signatureId`; the private key stays in your separately operated, encrypted Tatum KMS wallet. The backend does not need a Trust Wallet connection and never accepts a recovery phrase or private key. Tatum recommends KMS for mainnet signing; its API queues the transaction for KMS, and the KMS daemon signs and broadcasts it. See [Tatum's BSC transfer API](https://docs.tatum.io/reference/bscblockchaintransfer) and [KMS setup guide](https://docs.tatum.io/docs/kms-download-and-install-steps).

Create a dedicated payout wallet in Tatum KMS following Tatum's official setup guide. Use its BSC mainnet address and matching signature ID in the backend's private `.env`; set `TATUM_API_KEY`, `TATUM_KMS_SIGNATURE_ID`, `TATUM_PAYOUT_WALLET_ADDRESS`, and set `BSC_SEND_ADDRESS` to the same public address. Configure the same production API key in KMS. Keep the KMS `wallet.dat` and its unlock password on the machine running KMS, protected and backed up securely. Fund only the payout wallet with the USDT and BNB intended for payouts.

For mainnet, run the KMS daemon with the BSC chain and Tatum's four-eye option, using `http://localhost:4000/api/tatum/kms-approve/` when KMS and the backend run on the same computer, or the backend's HTTPS URL ending in `/api/tatum/kms-approve/` when they run on separate machines. The endpoint automatically approves only a Tatum request ID that VaultX created for a still-pending BEP20 withdrawal with matching signature ID, destination, and net amount. It returns a denial otherwise; no operator approval screen is required. The endpoint must be reachable from the KMS machine. Tatum documents that a 2xx response allows signing and a non-2xx response skips the transaction.

Keep `PAYOUT_AUTOMATION_ENABLED="false"` until the payout address, signature ID, KMS mainnet configuration, chain monitoring, and limits are verified. Set positive `PAYOUT_MAX_SINGLE_USDT` and `PAYOUT_DAILY_LIMIT_USDT` limits before enabling. The worker submits one payout at a time, checks USDT and estimated BNB gas balances, persists Tatum's KMS request ID, and leaves the ledger unchanged until the existing chain monitor confirms the exact outgoing transfer. Tatum's create request does not provide the same idempotency guarantee as the former connector: if the backend loses the response after submission begins, it deliberately pauses that payout instead of retrying and risking a duplicate. Reconcile such a request before any manual send. A transfer not confirmed on chain is not a completed withdrawal.

These are safeguards, not a substitute for sound custody operations. Do not enable real payouts until the ledger's liabilities have been reconciled with assets actually held, and keep the funded wallet balance limited. Never send Tatum API keys, KMS passwords, `wallet.dat`, recovery phrases, or private keys in chat or check them into source control. Do not use a personal Trust Wallet address as the automated signing wallet.

## TRON payout automation disabled

TRC20 payouts are not supported by the customer website. The TRON payout sender is not started by the server, even if old TRON payout environment settings remain in a local `.env`. Existing legacy withdrawal requests require separate manual reconciliation; do not send a TRC20 payout through the old automation.

## Trust Wallet withdrawal monitor

There is no payout screen in the customer-facing frontend. To use the background verifier with manually sent Trust Wallet payouts, set `WITHDRAWAL_MONITOR_ENABLED="true"` and configure `BSC_SEND_ADDRESS` to the public address that sends payouts. Never put a recovery phrase or private key in the app or `.env`.

The monitor watches confirmed BEP20 USDT transfers from that address. It verifies the token contract, sender, recipient, amount, and configured confirmation count, then completes only one unambiguous matching pending withdrawal and updates the ledger. If multiple requests have the same recipient and amount, the monitor leaves them pending rather than guessing. The first scan starts at the current confirmed BNB Smart Chain block; transfers sent before monitoring was enabled need manual review.

The monitor verifies transfers; BEP20 payouts use the optional Tatum KMS sender or the existing manual process. Start/restart the backend after changing environment settings. The older operator web page has been removed from the public frontend.

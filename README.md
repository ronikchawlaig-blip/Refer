# Telegram Refer & Reward Bot

A production-oriented Telegram-only refer-and-reward bot. The user experience and the complete admin control center live inside Telegram. There is no website, browser dashboard, admin URL, HTML admin page, React admin panel or external control surface.

## Included capabilities

- Colorful screenshot-inspired Telegram reply keyboard with the four requested user actions.
- Unique referral links with permanent `pending → subscribed → completed` state tracking.
- Referral completion only after every active force-subscribe channel and the mandatory disclaimer.
- Persistent disclaimer, content, settings and maintenance mode.
- Multiple force-subscribe channels with enable/disable and safe delete confirmation.
- Database-driven milestones, flexible reward inventory and Telegram file IDs for text, links, JSON, codes, photos, videos, GIFs, documents, APKs and other media.
- Transactional reward reservation with unique user/milestone and reward constraints, row locking, delivery history and failed-delivery tracking.
- Telegram admin center at `/admin` with dashboard, rewards, users, referrals, channels, content, broadcast, settings, admins and audit logs.
- User search, ban confirmation, progress reset confirmation, manual points/referral adjustments and history tables.
- Preview-first queued broadcasts with per-user jobs, rate limiting and success/failure counters.

## Recommended architecture

The bot runs as the existing API service so it has one managed process and one health endpoint:

```text
artifacts/api-server/src/index.ts
  ├── Express health service
  └── telegram/bot.ts
        └── telegram/store.ts
lib/db/src/schema/index.ts
```

PostgreSQL is the source of truth. Telegram media is referenced by Telegram `file_id`, avoiding unnecessary downloads while preserving support for Telegram-native content types.

## Setup

1. Create a bot with BotFather and add `TELEGRAM_BOT_TOKEN` in Replit Secrets.
2. Rotate any database credential that was previously pasted into chat. Add the rotated connection string as `NEON_DATABASE_URL` in Replit Secrets.
3. Ensure the bot is an administrator in every force-subscribe channel it will verify.
4. Install dependencies and push the schema:

```bash
pnpm install
pnpm --filter @workspace/db run push
```

5. Start the managed API workflow:

```bash
pnpm --filter @workspace/api-server run dev
```

6. Send `/start` to the bot. The owner account is pre-seeded from the configured owner ID in the bot store.

## Operations

- `pnpm run typecheck` — full TypeScript check.
- `pnpm --filter @workspace/db run push` — apply the current Drizzle schema to the configured database.
- `pnpm --filter @workspace/api-server run build` — build the API/bot bundle.

The bot uses long polling by default, which avoids needing a public webhook URL. On shutdown it stops polling cleanly. Do not run more than one bot process against the same token.
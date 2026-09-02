# Telegram Refer & Reward Bot

A production Telegram-native referral and reward bot with a secure, database-backed admin panel that never requires a website.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `TELEGRAM_BOT_TOKEN` — Telegram BotFather token
- Required env: `DATABASE_URL` or `NEON_DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/api-server/src/telegram/bot.ts` — Telegram handlers, flows and native admin panel
- `lib/db/src/schema/index.ts` — persistent user, referral, reward, content, broadcast and audit models
- `attached_assets/` — visual reference only; no web UI is used

## Architecture decisions

- The admin panel is implemented exclusively with Telegram commands, callback keyboards and message editing.
- Reward inventory is reserved inside a transaction and protected by a unique claim per user/milestone.
- Telegram file IDs are stored instead of downloading bot media; this supports any Telegram-supported reward media.
- Referral completion is gated by all active channels and disclaimer acceptance.

## Product

Users get a colorful Telegram-native refer-and-reward experience with a four-action main menu. Authorized admins manage content, channels, milestones, inventory, users, broadcasts and audit logs inside Telegram.

## User preferences

- User explicitly requires colorful screenshot-inspired Telegram buttons, premium responses, minimal loading spam, no leaderboard, and no external admin website.

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details

import {
  boolean,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------
// Reconstructed from usage in artifacts/api-server/src/telegram/bot.ts and
// store.ts. The original lib/db/src/schema/index.ts was never committed to
// GitHub; see the PR description for the evidence and the uncertain choices
// (notably: Postgres table/column names are snake_case derived from the
// camelCase Drizzle field names used in code, and are only safe on a fresh
// database — they must match the existing Replit database if one is reused).

export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  telegramId: text("telegram_id").notNull().unique(),
  username: text("username"),
  firstName: text("first_name"),
  lastName: text("last_name"),
  referralCount: integer("referral_count").notNull().default(0),
  points: integer("points").notNull().default(0),
  // No .references() here: a self-reference inside its own initializer
  // makes TypeScript infer usersTable as any (TS7022). It is a foreign key
  // to users.id in intent; the code only ever compares it to a user id.
  referredByUserId: integer("referred_by_user_id"),
  banned: boolean("banned").notNull().default(false),
  disclaimerAcceptedAt: timestamp("disclaimer_accepted_at"),
  joinedAt: timestamp("joined_at").notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at"),
});

// ---------------------------------------------------------------------------
// Referrals
// ---------------------------------------------------------------------------

export const referralsTable = pgTable(
  "referrals",
  {
    id: serial("id").primaryKey(),
    inviterUserId: integer("inviter_user_id")
      .notNull()
      .references(() => usersTable.id),
    referredUserId: integer("referred_user_id")
      .notNull()
      .references(() => usersTable.id),
    sourcePayload: text("source_payload").notNull(),
    status: text("status").notNull(),
    completedAt: timestamp("completed_at"),
  },
  (t) => [unique("referrals_referred_user_id_unique").on(t.referredUserId)],
);

// ---------------------------------------------------------------------------
// History tables (insert-only in the code)
// ---------------------------------------------------------------------------

export const referralHistoryTable = pgTable("referral_history", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => usersTable.id),
  adminTelegramId: text("admin_telegram_id").notNull(),
  delta: integer("delta").notNull(),
  reason: text("reason").notNull(),
});

export const pointHistoryTable = pgTable("point_history", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => usersTable.id),
  adminTelegramId: text("admin_telegram_id").notNull(),
  delta: integer("delta").notNull(),
  reason: text("reason").notNull(),
});

// ---------------------------------------------------------------------------
// Rewards
// ---------------------------------------------------------------------------

export const milestonesTable = pgTable("milestones", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  referralsRequired: integer("referrals_required").notNull(),
  sortOrder: integer("sort_order").notNull(),
  enabled: boolean("enabled").notNull().default(true),
});

export const rewardInventoryTable = pgTable("reward_inventory", {
  id: serial("id").primaryKey(),
  milestoneId: integer("milestone_id")
    .notNull()
    .references(() => milestonesTable.id),
  status: text("status").notNull().default("available"),
  contentType: text("content_type").notNull(),
  textContent: text("text_content"),
  fileId: text("file_id"),
  fileName: text("file_name"),
  mimeType: text("mime_type"),
  caption: text("caption"),
  metadata: jsonb("metadata").$type<{ addedBy: string }>(),
  assignedToUserId: integer("assigned_to_user_id").references(
    () => usersTable.id,
  ),
  assignedAt: timestamp("assigned_at"),
  deliveryAttempts: integer("delivery_attempts").notNull().default(0),
  deliveredAt: timestamp("delivered_at"),
  lastError: text("last_error"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const rewardClaimsTable = pgTable(
  "reward_claims",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id),
    milestoneId: integer("milestone_id")
      .notNull()
      .references(() => milestonesTable.id),
    rewardId: integer("reward_id")
      .notNull()
      .references(() => rewardInventoryTable.id),
    status: text("status").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    deliveredAt: timestamp("delivered_at"),
    lastError: text("last_error"),
  },
  (t) => [
    // INFERRED, not proven by an onConflict target: reserveReward()
    // (store.ts) + README "unique claim per user/milestone" imply one
    // claim per (user, milestone).
    unique("reward_claims_user_milestone_unique").on(t.userId, t.milestoneId),
  ],
);

// ---------------------------------------------------------------------------
// Key/value tables (natural key is the PK — no .id is ever used)
// ---------------------------------------------------------------------------

export const contentTable = pgTable("content", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at"),
});

export const settingsTable = pgTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at"),
});

// ---------------------------------------------------------------------------
// Admins / sessions / audit
// ---------------------------------------------------------------------------

export const adminsTable = pgTable("admins", {
  telegramId: text("telegram_id").primaryKey(),
  role: text("role").notNull(),
  // UNCERTAIN: jsonb vs text[] — code only ever inserts string[].
  permissions: jsonb("permissions").$type<string[]>().notNull(),
  active: boolean("active").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const adminSessionsTable = pgTable("admin_sessions", {
  telegramId: text("telegram_id").primaryKey(),
  state: text("state").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  updatedAt: timestamp("updated_at"),
});

export const auditLogsTable = pgTable("audit_logs", {
  id: serial("id").primaryKey(),
  adminTelegramId: text("admin_telegram_id"),
  action: text("action").notNull(),
  targetType: text("target_type"),
  targetId: text("target_id"),
  details: jsonb("details").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Broadcasts
// ---------------------------------------------------------------------------

export const broadcastsTable = pgTable("broadcasts", {
  id: serial("id").primaryKey(),
  adminTelegramId: text("admin_telegram_id").notNull(),
  contentType: text("content_type").notNull(),
  payload: jsonb("payload")
    .$type<{
      contentType: string;
      textContent?: string;
      fileId?: string;
      fileName?: string;
      mimeType?: string;
      caption?: string;
    }>()
    .notNull(),
  total: integer("total").notNull(),
  sent: integer("sent").notNull().default(0),
  failed: integer("failed").notNull().default(0),
  status: text("status").notNull(),
  finishedAt: timestamp("finished_at"),
});

export const broadcastJobsTable = pgTable("broadcast_jobs", {
  id: serial("id").primaryKey(),
  broadcastId: integer("broadcast_id")
    .notNull()
    .references(() => broadcastsTable.id),
  userId: integer("user_id")
    .notNull()
    .references(() => usersTable.id),
  status: text("status").notNull().default("queued"),
  sentAt: timestamp("sent_at"),
  error: text("error"),
});

// ---------------------------------------------------------------------------
// Force-subscribe channels
// ---------------------------------------------------------------------------

export const forceSubscribeChannelsTable = pgTable(
  "force_subscribe_channels",
  {
    id: serial("id").primaryKey(),
    chatId: text("chat_id").notNull(),
    title: text("title").notNull(),
    inviteLink: text("invite_link").notNull(),
    sortOrder: integer("sort_order").notNull(),
    enabled: boolean("enabled").notNull().default(true),
  },
);

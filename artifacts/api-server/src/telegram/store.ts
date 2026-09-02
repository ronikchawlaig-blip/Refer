import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  adminsTable,
  auditLogsTable,
  contentTable,
  forceSubscribeChannelsTable,
  milestonesTable,
  referralsTable,
  rewardClaimsTable,
  rewardInventoryTable,
  settingsTable,
  usersTable,
} from "@workspace/db";

export const OWNER_ID = "713914937";

export const DEFAULT_CONTENT: Record<string, string> = {
  welcome:
    "✨ Welcome to Refer & Reward\n\nInvite genuine new users, unlock milestones and receive your reward directly here.",
  force_subscribe:
    "🔒 One quick step before we continue\n\nJoin every required channel below, then tap Check Subscription.",
  disclaimer:
    "⚠️ IMPORTANT WARNING: Rewards are added to the bot in bulk, so occasionally you may receive a duplicate, expired, already-used, invalid, or non-working reward. If you receive only 1–2 such rewards, please do not contact Support, as minor issues can happen during bulk distribution. However, if you repeatedly receive the same issue across multiple rewards, you may contact the Support Bot and an admin will review the situation and assist where possible. By clicking Accept & Continue, you confirm that you understand and accept these terms.",
  support:
    "💬 Leave your message on our Support Bot. Our team will respond as soon as possible.",
  maintenance:
    "🚧 The bot is briefly unavailable for maintenance. Please try again shortly.",
  how_it_works:
    "1. Share your personal link.\n2. Your friend joins every required channel.\n3. They accept the disclaimer.\n4. Your referral becomes valid and your next milestone unlocks.",
  reward_success: "🎉 Reward unlocked!\n\nYour reward is being delivered securely.",
  reward_empty:
    "Your milestone is unlocked, but this reward is temporarily out of stock. Please check again later.",
  verification_error:
    "We could not verify one or more channels right now. Please try again in a moment.",
};

export const DEFAULT_SETTINGS: Record<string, string> = {
  disclaimer_enabled: "true",
  maintenance_enabled: "false",
  referral_enabled: "true",
  support_link: "https://t.me/",
  support_button: "💬 Support",
  bot_name: "Refer & Reward",
};

export async function seedDefaults() {
  for (const [key, value] of Object.entries(DEFAULT_CONTENT)) {
    await db
      .insert(contentTable)
      .values({ key, value })
      .onConflictDoNothing({ target: contentTable.key });
  }
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await db
      .insert(settingsTable)
      .values({ key, value })
      .onConflictDoNothing({ target: settingsTable.key });
  }
  await db
    .insert(adminsTable)
    .values({
      telegramId: OWNER_ID,
      role: "owner",
      permissions: ["*"],
      active: true,
    })
    .onConflictDoNothing({ target: adminsTable.telegramId });
  const existingMilestone = await db
    .select({ id: milestonesTable.id })
    .from(milestonesTable)
    .limit(1);
  if (existingMilestone.length === 0) {
    await db.insert(milestonesTable).values([
      { name: "Starter reward", referralsRequired: 5, sortOrder: 0 },
      { name: "Growth reward", referralsRequired: 10, sortOrder: 1 },
      { name: "Power reward", referralsRequired: 20, sortOrder: 2 },
    ]);
  }
}

export async function getContent(key: string) {
  const rows = await db
    .select({ value: contentTable.value })
    .from(contentTable)
    .where(eq(contentTable.key, key))
    .limit(1);
  return rows[0]?.value ?? DEFAULT_CONTENT[key] ?? "";
}

export async function setContent(key: string, value: string) {
  await db
    .insert(contentTable)
    .values({ key, value })
    .onConflictDoUpdate({
      target: contentTable.key,
      set: { value, updatedAt: new Date() },
    });
}

export async function getSetting(key: string) {
  const rows = await db
    .select({ value: settingsTable.value })
    .from(settingsTable)
    .where(eq(settingsTable.key, key))
    .limit(1);
  return rows[0]?.value ?? DEFAULT_SETTINGS[key] ?? "";
}

export async function setSetting(key: string, value: string) {
  await db
    .insert(settingsTable)
    .values({ key, value })
    .onConflictDoUpdate({
      target: settingsTable.key,
      set: { value, updatedAt: new Date() },
    });
}

export async function isAdmin(telegramId: string) {
  if (telegramId === OWNER_ID) return true;
  const rows = await db
    .select({ active: adminsTable.active })
    .from(adminsTable)
    .where(
      and(eq(adminsTable.telegramId, telegramId), eq(adminsTable.active, true)),
    )
    .limit(1);
  return rows.length > 0;
}

export async function getAdmin(telegramId: string) {
  const rows = await db
    .select()
    .from(adminsTable)
    .where(eq(adminsTable.telegramId, telegramId))
    .limit(1);
  return rows[0];
}

export async function audit(
  adminTelegramId: string,
  action: string,
  targetType?: string,
  targetId?: string,
  details?: Record<string, unknown>,
) {
  await db.insert(auditLogsTable).values({
    adminTelegramId,
    action,
    targetType,
    targetId,
    details,
  });
}

export async function upsertUser(from: {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
}) {
  const telegramId = String(from.id);
  const existing = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.telegramId, telegramId))
    .limit(1);
  if (existing[0]) {
    const updated = await db
      .update(usersTable)
      .set({
        username: from.username,
        firstName: from.first_name,
        lastName: from.last_name,
        lastSeenAt: new Date(),
      })
      .where(eq(usersTable.id, existing[0].id))
      .returning();
    return updated[0];
  }
  const inserted = await db
    .insert(usersTable)
    .values({
      telegramId,
      username: from.username,
      firstName: from.first_name,
      lastName: from.last_name,
    })
    .returning();
  return inserted[0];
}

export async function registerReferral(
  inviterTelegramId: string,
  referredUserId: number,
  payload: string,
) {
  const inviter = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.telegramId, inviterTelegramId))
    .limit(1);
  if (!inviter[0] || inviter[0].id === referredUserId) return;
  await db
    .update(usersTable)
    .set({ referredByUserId: inviter[0].id })
    .where(
      and(eq(usersTable.id, referredUserId), sql`${usersTable.referredByUserId} IS NULL`),
    );
  await db
    .insert(referralsTable)
    .values({
      inviterUserId: inviter[0].id,
      referredUserId,
      sourcePayload: payload,
      status: "pending",
    })
    .onConflictDoNothing({ target: referralsTable.referredUserId });
}

export async function getUserByTelegramId(telegramId: string) {
  const rows = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.telegramId, telegramId))
    .limit(1);
  return rows[0];
}

export async function getChannels() {
  return db
    .select()
    .from(forceSubscribeChannelsTable)
    .where(eq(forceSubscribeChannelsTable.enabled, true))
    .orderBy(asc(forceSubscribeChannelsTable.sortOrder));
}

export async function markSubscribed(userId: number) {
  await db
    .update(referralsTable)
    .set({ status: "subscribed" })
    .where(
      and(
        eq(referralsTable.referredUserId, userId),
        eq(referralsTable.status, "pending"),
      ),
    );
}

export async function completeReferral(userId: number) {
  return db.transaction(async (tx) => {
    const completed = await tx
      .update(referralsTable)
      .set({ status: "completed", completedAt: new Date() })
      .where(
        and(
          eq(referralsTable.referredUserId, userId),
          ne(referralsTable.status, "completed"),
        ),
      )
      .returning({ inviterUserId: referralsTable.inviterUserId });
    const referral = completed[0];
    if (!referral) return null;
    await tx
      .update(usersTable)
      .set({ referralCount: sql`${usersTable.referralCount} + 1` })
      .where(eq(usersTable.id, referral.inviterUserId));
    return referral.inviterUserId;
  });
}

export async function reserveReward(userId: number, milestoneId: number) {
  return db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(rewardClaimsTable)
      .where(
        and(
          eq(rewardClaimsTable.userId, userId),
          eq(rewardClaimsTable.milestoneId, milestoneId),
        ),
      )
      .limit(1);
    if (existing[0]) {
      return { claim: existing[0], reward: null };
    }
    const available = await tx
      .select()
      .from(rewardInventoryTable)
      .where(
        and(
          eq(rewardInventoryTable.milestoneId, milestoneId),
          eq(rewardInventoryTable.status, "available"),
        ),
      )
      .orderBy(asc(rewardInventoryTable.id))
      .limit(1)
      .for("update");
    const reward = available[0];
    if (!reward) return { claim: null, reward: null };
    const now = new Date();
    await tx
      .update(rewardInventoryTable)
      .set({
        status: "assigned",
        assignedToUserId: userId,
        assignedAt: now,
        deliveryAttempts: sql`${rewardInventoryTable.deliveryAttempts} + 1`,
      })
      .where(
        and(
          eq(rewardInventoryTable.id, reward.id),
          eq(rewardInventoryTable.status, "available"),
        ),
      );
    const claims = await tx
      .insert(rewardClaimsTable)
      .values({ userId, milestoneId, rewardId: reward.id, status: "reserved" })
      .returning();
    return { claim: claims[0], reward };
  });
}

export async function markRewardDelivered(rewardId: number, claimId: number) {
  await db.transaction(async (tx) => {
    const now = new Date();
    await tx
      .update(rewardInventoryTable)
      .set({ status: "delivered", deliveredAt: now })
      .where(eq(rewardInventoryTable.id, rewardId));
    await tx
      .update(rewardClaimsTable)
      .set({ status: "delivered", deliveredAt: now })
      .where(eq(rewardClaimsTable.id, claimId));
  });
}

export async function markRewardFailed(
  rewardId: number,
  claimId: number,
  error: string,
) {
  await db.transaction(async (tx) => {
    await tx
      .update(rewardInventoryTable)
      .set({ status: "failed", lastError: error })
      .where(eq(rewardInventoryTable.id, rewardId));
    await tx
      .update(rewardClaimsTable)
      .set({ status: "failed", lastError: error })
      .where(eq(rewardClaimsTable.id, claimId));
  });
}

export async function getMilestones() {
  return db
    .select()
    .from(milestonesTable)
    .where(eq(milestonesTable.enabled, true))
    .orderBy(asc(milestonesTable.referralsRequired));
}

export async function getUserClaims(userId: number) {
  return db
    .select({
      claim: rewardClaimsTable,
      milestone: milestonesTable,
      reward: rewardInventoryTable,
    })
    .from(rewardClaimsTable)
    .innerJoin(
      milestonesTable,
      eq(rewardClaimsTable.milestoneId, milestonesTable.id),
    )
    .innerJoin(
      rewardInventoryTable,
      eq(rewardClaimsTable.rewardId, rewardInventoryTable.id),
    )
    .where(eq(rewardClaimsTable.userId, userId))
    .orderBy(desc(rewardClaimsTable.createdAt));
}

export async function stats() {
  const [users, verified, referrals, delivered, available, used, failed] =
    await Promise.all([
      db.select({ count: sql<number>`count(*)` }).from(usersTable),
      db
        .select({ count: sql<number>`count(*)` })
        .from(usersTable)
        .where(sql`${usersTable.disclaimerAcceptedAt} IS NOT NULL`),
      db
        .select({ count: sql<number>`count(*)` })
        .from(referralsTable)
        .where(eq(referralsTable.status, "completed")),
      db
        .select({ count: sql<number>`count(*)` })
        .from(rewardInventoryTable)
        .where(eq(rewardInventoryTable.status, "delivered")),
      db
        .select({ count: sql<number>`count(*)` })
        .from(rewardInventoryTable)
        .where(eq(rewardInventoryTable.status, "available")),
      db
        .select({ count: sql<number>`count(*)` })
        .from(rewardInventoryTable)
        .where(sql`${rewardInventoryTable.status} IN ('assigned','delivered','failed')`),
      db
        .select({ count: sql<number>`count(*)` })
        .from(rewardInventoryTable)
        .where(eq(rewardInventoryTable.status, "failed")),
    ]);
  return {
    users: Number(users[0]?.count ?? 0),
    verified: Number(verified[0]?.count ?? 0),
    referrals: Number(referrals[0]?.count ?? 0),
    delivered: Number(delivered[0]?.count ?? 0),
    available: Number(available[0]?.count ?? 0),
    used: Number(used[0]?.count ?? 0),
    failed: Number(failed[0]?.count ?? 0),
  };
}
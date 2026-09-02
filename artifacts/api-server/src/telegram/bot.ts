import { and, asc, desc, eq, sql } from "drizzle-orm";
import { Markup, Telegraf } from "telegraf";
import type { Context } from "telegraf";
import type { InlineKeyboardButton } from "telegraf/types";
import { db } from "@workspace/db";
import {
  adminSessionsTable,
  adminsTable,
  auditLogsTable,
  broadcastsTable,
  broadcastJobsTable,
  contentTable,
  forceSubscribeChannelsTable,
  milestonesTable,
  pointHistoryTable,
  referralHistoryTable,
  rewardClaimsTable,
  rewardInventoryTable,
  referralsTable,
  usersTable,
} from "@workspace/db";
import { logger } from "../lib/logger";
import {
  DEFAULT_CONTENT,
  DEFAULT_SETTINGS,
  OWNER_ID,
  audit,
  completeReferral,
  getAdmin,
  getChannels,
  getContent,
  getMilestones,
  getSetting,
  getUserByTelegramId,
  getUserClaims,
  isAdmin,
  markRewardDelivered,
  markRewardFailed,
  markSubscribed,
  registerReferral,
  reserveReward,
  seedDefaults,
  setContent,
  setSetting,
  stats,
  upsertUser,
} from "./store";

type SessionPayload = Record<string, unknown>;
type BotContext = Context;

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const MAIN_BUTTONS = {
  referrals: "👥 Refer & Earn",
  rewards: "🎁 My Rewards",
  progress: "📊 My Progress",
  support: "💬 Support",
} as const;

const ADMIN_BUTTON = "🛡️ Admin Panel";

type StyledKeyboardButton = {
  text: string;
  style: "primary" | "success" | "danger";
};

const MAIN_BUTTON_STYLES: Record<string, StyledKeyboardButton["style"]> = {
  [MAIN_BUTTONS.referrals]: "primary",
  [MAIN_BUTTONS.rewards]: "primary",
  [MAIN_BUTTONS.progress]: "success",
  [MAIN_BUTTONS.support]: "success",
  [ADMIN_BUTTON]: "danger",
};

function buildMainKeyboard(isAdminUser: boolean) {
  const rows: StyledKeyboardButton[][] = [
    [
      { text: MAIN_BUTTONS.referrals, style: MAIN_BUTTON_STYLES[MAIN_BUTTONS.referrals] },
      { text: MAIN_BUTTONS.rewards, style: MAIN_BUTTON_STYLES[MAIN_BUTTONS.rewards] },
    ],
    [
      { text: MAIN_BUTTONS.progress, style: MAIN_BUTTON_STYLES[MAIN_BUTTONS.progress] },
      { text: MAIN_BUTTONS.support, style: MAIN_BUTTON_STYLES[MAIN_BUTTONS.support] },
    ],
  ];
  if (isAdminUser) {
    rows.push([{ text: ADMIN_BUTTON, style: MAIN_BUTTON_STYLES[ADMIN_BUTTON] }]);
  }
  // Telegraf 4.16's types predate Telegram's button-style field, but it
  // forwards this valid Bot API object unchanged at runtime.
  return Markup.keyboard(rows as any).resize().persistent();
}

const adminKeyboard = Markup.inlineKeyboard([
  [Markup.button.callback("📊 Dashboard", "admin:dashboard")],
  [
    Markup.button.callback("🎁 Rewards", "admin:rewards"),
    Markup.button.callback("👥 Users", "admin:users"),
  ],
  [
    Markup.button.callback("🔗 Referrals", "admin:referrals"),
    Markup.button.callback("🔒 Force Subscribe", "admin:channels"),
  ],
  [
    Markup.button.callback("📝 Content", "admin:content"),
    Markup.button.callback("📢 Broadcast", "admin:broadcast"),
  ],
  [
    Markup.button.callback("⚙️ Settings", "admin:settings"),
    Markup.button.callback("🛡️ Admins", "admin:admins"),
  ],
  [Markup.button.callback("📜 Logs", "admin:logs")],
]);

function fromUser(ctx: BotContext) {
  if (!ctx.from) throw new Error("Telegram user is missing");
  return ctx.from;
}

function telegramId(ctx: BotContext) {
  return String(fromUser(ctx).id);
}

async function safeEdit(ctx: BotContext, text: string, extra?: object) {
  const options = { parse_mode: "HTML" as const, ...(extra ?? {}) };
  try {
    if (ctx.callbackQuery) {
      await ctx.editMessageText(text, options);
    } else {
      await ctx.reply(text, options);
    }
  } catch (error) {
    logger.debug({ error }, "Telegram message edit fallback");
    await ctx.reply(text, options).catch(() => undefined);
  }
}

async function answer(ctx: BotContext, text?: string) {
  if (ctx.callbackQuery) {
    await ctx.answerCbQuery(text).catch(() => undefined);
  }
}

async function animateTransition(ctx: BotContext, _label: string) {
  await ctx.telegram
    .sendChatAction(fromUser(ctx).id, "typing")
    .catch(() => undefined);
}

async function getSession(telegramUserId: string) {
  const rows = await db
    .select()
    .from(adminSessionsTable)
    .where(eq(adminSessionsTable.telegramId, telegramUserId))
    .limit(1);
  return rows[0];
}

async function setSession(
  telegramUserId: string,
  state: string,
  payload: SessionPayload = {},
) {
  await db
    .insert(adminSessionsTable)
    .values({ telegramId: telegramUserId, state, payload })
    .onConflictDoUpdate({
      target: adminSessionsTable.telegramId,
      set: { state, payload, updatedAt: new Date() },
    });
}

async function clearSession(telegramUserId: string) {
  await db
    .delete(adminSessionsTable)
    .where(eq(adminSessionsTable.telegramId, telegramUserId));
}

async function isMaintenanceBlocked(ctx: BotContext) {
  if ((await getSetting("maintenance_enabled")) !== "true") return false;
  return !(await isAdmin(telegramId(ctx)));
}

async function ensureUser(ctx: BotContext) {
  return upsertUser(fromUser(ctx));
}

async function renderMain(ctx: BotContext, prefix = "") {
  const user = await ensureUser(ctx);
  const welcome = await getContent("welcome");
  await safeEdit(
    ctx,
    `${prefix}${welcome}\n\nChoose an option below to continue.`,
    buildMainKeyboard(await isAdmin(user.telegramId)),
  );
  return user;
}

async function renderDisclaimer(ctx: BotContext) {
  const disclaimer = await getContent("disclaimer");
  await safeEdit(
    ctx,
    `🧾 <b>One final confirmation</b>\n\n${disclaimer}`,
    Markup.inlineKeyboard([
      [Markup.button.callback("✅ Accept & Continue", "disclaimer:accept")],
    ]),
  );
}

async function verifySubscriptions(ctx: BotContext, userId: number) {
  const channels = await getChannels();
  const missing: typeof channels = [];
  for (const channel of channels) {
    try {
      const member = await ctx.telegram.getChatMember(
        channel.chatId,
        Number(telegramId(ctx)),
      );
      const joined =
        member.status === "creator" ||
        member.status === "administrator" ||
        member.status === "member" ||
        (member.status === "restricted" && member.is_member);
      if (!joined) missing.push(channel);
    } catch (error) {
      logger.warn(
        { error, channelId: channel.chatId },
        "Could not verify force subscription channel",
      );
      missing.push(channel);
    }
  }
  if (missing.length === 0) await markSubscribed(userId);
  return missing;
}

async function renderAccessGate(ctx: BotContext, user: Awaited<ReturnType<typeof upsertUser>>) {
  if ((await getSetting("disclaimer_enabled")) === "true" && user.disclaimerAcceptedAt) {
    return renderMain(ctx);
  }
  const channels = await getChannels();
  if (channels.length === 0) {
    if ((await getSetting("disclaimer_enabled")) === "true") return renderDisclaimer(ctx);
    return renderMain(ctx);
  }
  const body = await getContent("force_subscribe");
  const buttons: InlineKeyboardButton[][] = channels.map((channel) => [
    Markup.button.url(`📣 ${channel.title}`, channel.inviteLink),
  ]);
  buttons.push([Markup.button.callback("🔄 Check Subscription", "access:check")]);
  await safeEdit(ctx, body, Markup.inlineKeyboard(buttons));
}

async function sendReward(
  ctx: BotContext,
  reward: typeof rewardInventoryTable.$inferSelect,
  chatId = fromUser(ctx).id,
) {
  const caption = reward.caption ?? undefined;
  const action = !reward.fileId
    ? "typing"
    : reward.contentType === "photo"
      ? "upload_photo"
      : reward.contentType === "video" || reward.contentType === "animation"
        ? "upload_video"
        : reward.contentType === "voice"
          ? "record_voice"
          : "upload_document";
  await ctx.telegram.sendChatAction(chatId, action).catch(() => undefined);
  if (reward.contentType === "photo" && reward.fileId) {
    await ctx.telegram.sendPhoto(chatId, reward.fileId, { caption });
  } else if (reward.contentType === "video" && reward.fileId) {
    await ctx.telegram.sendVideo(chatId, reward.fileId, { caption });
  } else if (reward.contentType === "animation" && reward.fileId) {
    await ctx.telegram.sendAnimation(chatId, reward.fileId, { caption });
  } else if (reward.contentType === "document" && reward.fileId) {
    await ctx.telegram.sendDocument(chatId, reward.fileId, { caption });
  } else if (reward.contentType === "audio" && reward.fileId) {
    await ctx.telegram.sendAudio(chatId, reward.fileId, { caption });
  } else if (reward.contentType === "voice" && reward.fileId) {
    await ctx.telegram.sendVoice(chatId, reward.fileId, { caption });
  } else {
    await ctx.telegram.sendMessage(chatId, reward.textContent ?? "Your reward is ready.");
  }
}

async function deliverUnlockedRewards(
  ctx: BotContext,
  userId: number,
  referralCount: number,
  deliveryChatId = fromUser(ctx).id,
) {
  const milestones = await getMilestones();
  let delivered = 0;
  for (const milestone of milestones) {
    if (referralCount < milestone.referralsRequired) continue;
    const reserved = await reserveReward(userId, milestone.id);
    if (!reserved.reward || !reserved.claim) continue;
    try {
      await sendReward(ctx, reserved.reward, deliveryChatId);
      await markRewardDelivered(reserved.reward.id, reserved.claim.id);
      delivered += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Telegram delivery failed";
      await markRewardFailed(reserved.reward.id, reserved.claim.id, message);
      logger.error({ error, rewardId: reserved.reward.id }, "Reward delivery failed");
    }
  }
  return delivered;
}

async function handleStart(ctx: BotContext, payload = "") {
  if (await isMaintenanceBlocked(ctx)) {
    await ctx.reply(await getContent("maintenance"));
    return;
  }
  const existed = await getUserByTelegramId(telegramId(ctx));
  const user = await ensureUser(ctx);
  if (!existed && payload.startsWith("ref_")) {
    await registerReferral(payload.slice(4), user.id, payload);
  }
  if (user.banned) {
    await ctx.reply("Your access is currently restricted. Please contact Support.");
    return;
  }
  if (user.disclaimerAcceptedAt || (await getSetting("disclaimer_enabled")) !== "true") {
    await renderMain(ctx);
    return;
  }
  await renderAccessGate(ctx, user);
}

async function handleSubscriptionCheck(ctx: BotContext) {
  await answer(ctx);
  const user = await ensureUser(ctx);
  await safeEdit(ctx, "🔎 <b>Checking requirements...</b>");
  await sleep(180);
  await safeEdit(ctx, "🔐 <b>Verifying every channel...</b>");
  const missing = await verifySubscriptions(ctx, user.id);
  await sleep(180);
  if (missing.length > 0) {
    const body = `⚠️ <b>Almost there</b>\n\nPlease join the remaining channel${missing.length > 1 ? "s" : ""}, then check again.`;
    const buttons: InlineKeyboardButton[][] = missing.map((channel) => [
      Markup.button.url(`📣 ${channel.title}`, channel.inviteLink),
    ]);
    buttons.push([Markup.button.callback("🔄 Check Subscription", "access:check")]);
    await safeEdit(ctx, body, Markup.inlineKeyboard(buttons));
    return;
  }
  await safeEdit(ctx, "✅ <b>Verification successful</b>\n\nAccess unlocked. Preparing your final confirmation...");
  await sleep(220);
  await renderDisclaimer(ctx);
}

async function handleDisclaimerAccept(ctx: BotContext) {
  await answer(ctx);
  const user = await ensureUser(ctx);
  await db
    .update(usersTable)
    .set({ disclaimerAcceptedAt: new Date() })
    .where(eq(usersTable.id, user.id));
  const inviterUserId = await completeReferral(user.id);
  await safeEdit(ctx, inviterUserId ? "🎉 <b>Access unlocked!</b>\n\nYour referral has been validated securely." : "✅ <b>Access unlocked!</b>");
  await sleep(220);
  const updated = await getUserByTelegramId(telegramId(ctx));
  if (updated) {
    await deliverUnlockedRewards(ctx, updated.id, updated.referralCount);
    if (inviterUserId) {
      const inviter = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.id, inviterUserId))
        .limit(1);
      if (inviter[0]) {
        await deliverUnlockedRewards(
          ctx,
          inviter[0].id,
          inviter[0].referralCount,
          Number(inviter[0].telegramId),
        );
      }
    }
  }
  await renderMain(ctx);
}

async function referralView(ctx: BotContext) {
  const user = await ensureUser(ctx);
  const milestones = await getMilestones();
  const next = milestones.find((milestone) => milestone.referralsRequired > user.referralCount);
  const bot = await ctx.telegram.getMe();
  const link = `https://t.me/${bot.username}?start=ref_${user.telegramId}`;
  const remaining = next ? Math.max(0, next.referralsRequired - user.referralCount) : 0;
  const target = next?.referralsRequired ?? user.referralCount;
  await safeEdit(
    ctx,
    `👥 <b>Refer & Earn</b>\n\n🔗 <code>${link}</code>\n\n✅ Successful referrals: <b>${user.referralCount}</b>\n🎯 Next reward target: <b>${target}</b>\n📌 Remaining: <b>${remaining}</b>\n\nShare your personal link with a genuinely new user. Their referral becomes valid only after all requirements are completed.`,
    Markup.inlineKeyboard([
      [Markup.button.url("📤 Share referral link", `https://t.me/share/url?url=${encodeURIComponent(link)}`)],
      [Markup.button.callback("⬅️ Back", "user:home")],
    ]),
  );
}

async function rewardsView(ctx: BotContext) {
  const user = await ensureUser(ctx);
  const claims = await getUserClaims(user.id);
  const lines = claims.length
    ? claims
        .slice(0, 10)
        .map(
          ({ milestone, claim }) =>
            `${claim.status === "delivered" ? "✅" : claim.status === "failed" ? "⚠️" : "⏳"} ${milestone.name} — ${claim.status}`,
        )
        .join("\n")
    : "No rewards unlocked yet.";
  await safeEdit(
    ctx,
    `🎁 <b>My Rewards</b>\n\n${lines}\n\nRewards are reserved atomically and can never be assigned to two users.`,
    Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "user:home")]]),
  );
}

async function progressView(ctx: BotContext) {
  const user = await ensureUser(ctx);
  const milestones = await getMilestones();
  const current = milestones.filter((item) => item.referralsRequired <= user.referralCount).at(-1);
  const next = milestones.find((item) => item.referralsRequired > user.referralCount);
  await safeEdit(
    ctx,
    `📊 <b>My Progress</b>\n\n✅ Total successful referrals: <b>${user.referralCount}</b>\n🏅 Current milestone: <b>${current?.name ?? "Getting started"}</b>\n🎯 Next milestone: <b>${next?.name ?? "All milestones complete"}</b>\n📌 Remaining referrals: <b>${next ? next.referralsRequired - user.referralCount : 0}</b>\n⭐ Points: <b>${user.points}</b>`,
    Markup.inlineKeyboard([
      [Markup.button.callback("👥 View referral link", "user:referrals")],
      [Markup.button.callback("⬅️ Back", "user:home")],
    ]),
  );
}

async function supportView(ctx: BotContext) {
  const link = await getSetting("support_link");
  const text = await getContent("support");
  await safeEdit(
    ctx,
    text,
    Markup.inlineKeyboard([
      [Markup.button.url("💬 Open Support Bot", link)],
      [Markup.button.callback("⬅️ Back", "user:home")],
    ]),
  );
}

async function adminHome(ctx: BotContext) {
  if (!(await isAdmin(telegramId(ctx)))) {
    await safeEdit(ctx, "⛔ This area is restricted to authorized admins.");
    return;
  }
  await safeEdit(ctx, "🛡️ <b>Control Center</b>\n\nEverything below is managed directly inside Telegram.", adminKeyboard);
}

async function dashboardView(ctx: BotContext) {
  const data = await stats();
  await safeEdit(
    ctx,
    `📊 <b>Dashboard</b>\n\n👥 Total users: <b>${data.users}</b>\n✅ Verified users: <b>${data.verified}</b>\n🔗 Successful referrals: <b>${data.referrals}</b>\n🎁 Rewards delivered: <b>${data.delivered}</b>\n📦 Available stock: <b>${data.available}</b>\n🗃️ Used / assigned: <b>${data.used}</b>\n⚠️ Failed deliveries: <b>${data.failed}</b>`,
    Markup.inlineKeyboard([[Markup.button.callback("⬅️ Admin menu", "admin:home")]]),
  );
}

async function rewardsAdminView(ctx: BotContext) {
  const milestones = await db.select().from(milestonesTable).orderBy(asc(milestonesTable.referralsRequired));
  const stock = await db
    .select({ milestoneId: rewardInventoryTable.milestoneId, status: rewardInventoryTable.status, count: sql<number>`count(*)` })
    .from(rewardInventoryTable)
    .groupBy(rewardInventoryTable.milestoneId, rewardInventoryTable.status);
  const lines = milestones.map((m) => {
    const items = stock.filter((row) => row.milestoneId === m.id);
    const available = Number(items.find((row) => row.status === "available")?.count ?? 0);
    return `${m.enabled ? "🟢" : "🔴"} <b>${m.id}</b>. ${m.name} — ${m.referralsRequired} referrals — stock ${available}`;
  });
  const inventory = await db
    .select()
    .from(rewardInventoryTable)
    .orderBy(desc(rewardInventoryTable.createdAt))
    .limit(8);
  await safeEdit(
    ctx,
    `🎁 <b>Reward Management</b>\n\n${lines.join("\n") || "No milestones configured."}\n\n<b>Recent inventory</b>\n${inventory.map((item) => `• #${item.id} — ${item.contentType} — ${item.status}`).join("\n") || "No rewards stored."}`,
    Markup.inlineKeyboard([
      [Markup.button.callback("➕ Add reward", "admin:add_reward")],
      [Markup.button.callback("➕ Add milestone", "admin:add_milestone")],
      ...milestones.map((milestone) => [
        Markup.button.callback(
          `${milestone.enabled ? "🔴 Disable" : "🟢 Enable"} ${milestone.id}`,
          `admin:milestone_toggle:${milestone.id}`,
        ),
        Markup.button.callback(`✏️ ${milestone.id}`, `admin:milestone_edit:${milestone.id}`),
        Markup.button.callback(`🗑️ ${milestone.id}`, `admin:milestone_delete:${milestone.id}`),
      ]),
      ...inventory.map((item) => [
        Markup.button.callback(
          `${item.status === "available" ? "🔴 Disable" : "🟢 Enable"} reward #${item.id}`,
          `admin:reward_toggle:${item.id}`,
        ),
        Markup.button.callback(`✏️ #${item.id}`, `admin:reward_edit:${item.id}`),
        Markup.button.callback(`🗑️ #${item.id}`, `admin:reward_delete:${item.id}`),
      ]),
      [Markup.button.callback("📦 View stock", "admin:stock")],
      [Markup.button.callback("📜 Delivery history", "admin:delivery_history")],
      [Markup.button.callback("⬅️ Admin menu", "admin:home")],
    ]),
  );
}

async function channelsAdminView(ctx: BotContext) {
  const channels = await db.select().from(forceSubscribeChannelsTable).orderBy(asc(forceSubscribeChannelsTable.sortOrder));
  const lines = channels.map((channel) => `${channel.enabled ? "🟢" : "🔴"} <b>${channel.id}</b>. ${channel.title} — ${channel.chatId}`);
  const buttons = channels.flatMap((channel) => [
    [
      Markup.button.callback(`${channel.enabled ? "🔴 Disable" : "🟢 Enable"} ${channel.id}`, `admin:channel_toggle:${channel.id}`),
      Markup.button.callback(`✏️ ${channel.id}`, `admin:channel_edit:${channel.id}`),
      Markup.button.callback(`🗑️ ${channel.id}`, `admin:channel_delete:${channel.id}`),
    ],
    [
      Markup.button.callback(`⬆️ ${channel.id}`, `admin:channel_up:${channel.id}`),
      Markup.button.callback(`⬇️ ${channel.id}`, `admin:channel_down:${channel.id}`),
    ],
  ]);
  buttons.push([Markup.button.callback("➕ Add channel", "admin:add_channel")]);
  buttons.push([Markup.button.callback("⬅️ Admin menu", "admin:home")]);
  await safeEdit(ctx, `🔒 <b>Force Subscribe</b>\n\n${lines.join("\n") || "No channels configured."}`, Markup.inlineKeyboard(buttons));
}

async function contentAdminView(ctx: BotContext) {
  const keys = Object.keys(DEFAULT_CONTENT);
  const rows = keys.map((key) => [Markup.button.callback(`✏️ ${key.replaceAll("_", " ")}`, `admin:content_edit:${key}`)]);
  rows.push([Markup.button.callback("⬅️ Admin menu", "admin:home")]);
  await safeEdit(ctx, "📝 <b>Content Management</b>\n\nChoose any user-facing message to preview or edit.", Markup.inlineKeyboard(rows));
}

async function settingsAdminView(ctx: BotContext) {
  const maintenance = await getSetting("maintenance_enabled");
  const disclaimer = await getSetting("disclaimer_enabled");
  const referral = await getSetting("referral_enabled");
  await safeEdit(
    ctx,
    `⚙️ <b>Settings</b>\n\n🚧 Maintenance: <b>${maintenance}</b>\n🧾 Disclaimer: <b>${disclaimer}</b>\n🔗 Referral system: <b>${referral}</b>\n💬 Support: <code>${await getSetting("support_link")}</code>`,
    Markup.inlineKeyboard([
      [Markup.button.callback(`${maintenance === "true" ? "🔴 Turn maintenance off" : "🟢 Turn maintenance on"}`, "admin:maintenance_toggle")],
      [Markup.button.callback(`${disclaimer === "true" ? "🔴 Disable disclaimer" : "🟢 Enable disclaimer"}`, "admin:disclaimer_toggle")],
      [Markup.button.callback(`${referral === "true" ? "🔴 Disable referrals" : "🟢 Enable referrals"}`, "admin:referrals_toggle")],
      [Markup.button.callback("💬 Edit support link", "admin:support_edit")],
      [Markup.button.callback("⬅️ Admin menu", "admin:home")],
    ]),
  );
}

async function usersAdminView(ctx: BotContext) {
  await setSession(telegramId(ctx), "user_search");
  await safeEdit(ctx, "👥 <b>User search</b>\n\nSend the Telegram User ID to view and manage that user.\n\nSend /cancel to leave this flow.");
}

async function adminsAdminView(ctx: BotContext) {
  const admins = await db.select().from(adminsTable).orderBy(asc(adminsTable.createdAt));
  const lines = admins.map((admin) => `${admin.telegramId === OWNER_ID ? "👑" : "🛡️"} <code>${admin.telegramId}</code> — ${admin.role} — ${admin.active ? "active" : "disabled"}`);
  await safeEdit(
    ctx,
    `🛡️ <b>Admin Management</b>\n\n${lines.join("\n")}`,
    Markup.inlineKeyboard([
      [Markup.button.callback("➕ Add admin", "admin:add_admin")],
      [Markup.button.callback("⬅️ Admin menu", "admin:home")],
    ]),
  );
}

async function logsAdminView(ctx: BotContext) {
  const logs = await db.select().from(auditLogsTable).orderBy(desc(auditLogsTable.createdAt)).limit(12);
  const lines = logs.map((log) => `• ${log.action} — ${log.adminTelegramId ?? "system"}\n  ${log.createdAt.toISOString()}`);
  await safeEdit(ctx, `📜 <b>Audit Logs</b>\n\n${lines.join("\n") || "No audit entries yet."}`, Markup.inlineKeyboard([[Markup.button.callback("⬅️ Admin menu", "admin:home")]]));
}

async function stockAdminView(ctx: BotContext) {
  const rows = await db.select({ status: rewardInventoryTable.status, count: sql<number>`count(*)` }).from(rewardInventoryTable).groupBy(rewardInventoryTable.status);
  const lines = rows.map((row) => `• ${row.status}: <b>${row.count}</b>`);
  await safeEdit(ctx, `📦 <b>Reward Stock</b>\n\n${lines.join("\n") || "No rewards stored."}`, Markup.inlineKeyboard([[Markup.button.callback("⬅️ Rewards", "admin:rewards")]]));
}

async function deliveryHistoryView(ctx: BotContext) {
  const rows = await db.select({ claim: rewardClaimsTable, user: usersTable, milestone: milestonesTable }).from(rewardClaimsTable).innerJoin(usersTable, eq(rewardClaimsTable.userId, usersTable.id)).innerJoin(milestonesTable, eq(rewardClaimsTable.milestoneId, milestonesTable.id)).orderBy(desc(rewardClaimsTable.createdAt)).limit(12);
  const lines = rows.map(({ claim, user, milestone }) => `• ${user.telegramId} — ${milestone.name} — ${claim.status}`);
  await safeEdit(ctx, `📜 <b>Delivery History</b>\n\n${lines.join("\n") || "No delivery history yet."}`, Markup.inlineKeyboard([[Markup.button.callback("⬅️ Rewards", "admin:rewards")]]));
}

type IncomingMessage = {
  text?: string;
  caption?: string;
  photo?: Array<{ file_id: string }>;
  video?: { file_id: string; file_name?: string; mime_type?: string };
  animation?: { file_id: string; file_name?: string; mime_type?: string };
  document?: { file_id: string; file_name?: string; mime_type?: string };
  audio?: { file_id: string; file_name?: string; mime_type?: string };
  voice?: { file_id: string };
};

type MediaPayload = {
  contentType: string;
  textContent?: string;
  fileId?: string;
  fileName?: string;
  mimeType?: string;
  caption?: string;
};

function incomingMessage(ctx: BotContext) {
  return ctx.message as unknown as IncomingMessage;
}

function capturePayload(ctx: BotContext): MediaPayload {
  const message = incomingMessage(ctx);
  if (message.photo?.length) {
    return {
      contentType: "photo",
      fileId: message.photo.at(-1)?.file_id,
      caption: message.caption,
    };
  }
  for (const [key, contentType] of [
    ["video", "video"],
    ["animation", "animation"],
    ["document", "document"],
    ["audio", "audio"],
    ["voice", "voice"],
  ] as const) {
    const file = message[key];
    if (file) {
      return {
        contentType,
        fileId: file.file_id,
        fileName: "file_name" in file ? file.file_name : undefined,
        mimeType: "mime_type" in file ? file.mime_type : undefined,
        caption: message.caption,
      };
    }
  }
  return { contentType: "text", textContent: message.text ?? message.caption ?? "" };
}

function formatPayload(payload: MediaPayload) {
  if (payload.contentType === "text") return payload.textContent ?? "";
  return `📎 ${payload.contentType}${payload.fileName ? ` — ${payload.fileName}` : ""}\n${payload.caption ?? "No caption"}`;
}

async function sendBroadcastPayload(
  bot: Telegraf<BotContext>,
  telegramId: string,
  payload: MediaPayload,
) {
  const caption = payload.caption || undefined;
  if (payload.contentType === "photo" && payload.fileId) {
    await bot.telegram.sendPhoto(telegramId, payload.fileId, { caption });
  } else if (payload.contentType === "video" && payload.fileId) {
    await bot.telegram.sendVideo(telegramId, payload.fileId, { caption });
  } else if (payload.contentType === "animation" && payload.fileId) {
    await bot.telegram.sendAnimation(telegramId, payload.fileId, { caption });
  } else if (payload.contentType === "document" && payload.fileId) {
    await bot.telegram.sendDocument(telegramId, payload.fileId, { caption });
  } else if (payload.contentType === "audio" && payload.fileId) {
    await bot.telegram.sendAudio(telegramId, payload.fileId, { caption });
  } else if (payload.contentType === "voice" && payload.fileId) {
    await bot.telegram.sendVoice(telegramId, payload.fileId, { caption });
  } else {
    await bot.telegram.sendMessage(telegramId, payload.textContent ?? " ");
  }
}

async function runBroadcast(bot: Telegraf<BotContext>, broadcastId: number) {
  await db
    .update(broadcastsTable)
    .set({ status: "sending" })
    .where(eq(broadcastsTable.id, broadcastId));
  const broadcast = await db
    .select()
    .from(broadcastsTable)
    .where(eq(broadcastsTable.id, broadcastId))
    .limit(1);
  const payload = broadcast[0]?.payload as MediaPayload | undefined;
  if (!payload) return;
  const jobs = await db
    .select({ job: broadcastJobsTable, user: usersTable })
    .from(broadcastJobsTable)
    .innerJoin(usersTable, eq(broadcastJobsTable.userId, usersTable.id))
    .where(
      and(
        eq(broadcastJobsTable.broadcastId, broadcastId),
        eq(broadcastJobsTable.status, "queued"),
      ),
    )
    .orderBy(asc(broadcastJobsTable.id));
  for (const { job, user } of jobs) {
    try {
      await sendBroadcastPayload(bot, user.telegramId, payload);
      await db
        .update(broadcastJobsTable)
        .set({ status: "sent", sentAt: new Date() })
        .where(eq(broadcastJobsTable.id, job.id));
      await db
        .update(broadcastsTable)
        .set({ sent: sql`${broadcastsTable.sent} + 1` })
        .where(eq(broadcastsTable.id, broadcastId));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Delivery failed";
      await db
        .update(broadcastJobsTable)
        .set({ status: "failed", error: message })
        .where(eq(broadcastJobsTable.id, job.id));
      await db
        .update(broadcastsTable)
        .set({ failed: sql`${broadcastsTable.failed} + 1` })
        .where(eq(broadcastsTable.id, broadcastId));
    }
    await sleep(60);
  }
  await db
    .update(broadcastsTable)
    .set({ status: "completed", finishedAt: new Date() })
    .where(eq(broadcastsTable.id, broadcastId));
}

async function userAdminDetail(ctx: BotContext, userId: string) {
  const user = await getUserByTelegramId(userId);
  if (!user) {
    await safeEdit(ctx, "No user found for that Telegram ID.", Markup.inlineKeyboard([[Markup.button.callback("⬅️ Admin menu", "admin:home")]]));
    return;
  }
  const claims = await getUserClaims(user.id);
  await safeEdit(
    ctx,
    `👤 <b>User ${user.telegramId}</b>\n\nUsername: <b>${user.username ? `@${user.username}` : "—"}</b>\nJoined: <b>${user.joinedAt.toISOString()}</b>\nReferrals: <b>${user.referralCount}</b>\nPoints: <b>${user.points}</b>\nDisclaimer: <b>${user.disclaimerAcceptedAt ? "accepted" : "pending"}</b>\nBanned: <b>${user.banned ? "yes" : "no"}</b>\nRewards: <b>${claims.length}</b>`,
    Markup.inlineKeyboard([
      [Markup.button.callback(user.banned ? "🟢 Unban" : "🔴 Ban", `admin:user_ban:${user.telegramId}`)],
      [
        Markup.button.callback("➕ Points", `admin:user_amount:points_add:${user.telegramId}`),
        Markup.button.callback("➖ Points", `admin:user_amount:points_remove:${user.telegramId}`),
      ],
      [
        Markup.button.callback("➕ Referrals", `admin:user_amount:ref_add:${user.telegramId}`),
        Markup.button.callback("➖ Referrals", `admin:user_amount:ref_remove:${user.telegramId}`),
      ],
      [Markup.button.callback("♻️ Reset progress", `admin:user_reset:${user.telegramId}`)],
      [Markup.button.callback("⬅️ Users", "admin:users")],
    ]),
  );
}

async function referralsAdminView(ctx: BotContext) {
  const rows = await db
    .select({ status: referralsTable.status, count: sql<number>`count(*)` })
    .from(referralsTable)
    .groupBy(referralsTable.status);
  await safeEdit(
    ctx,
    `🔗 <b>Referral Management</b>\n\n${rows.map((row) => `• ${row.status}: <b>${row.count}</b>`).join("\n") || "No referrals yet."}\n\nMilestones and manual referral adjustments are available from Rewards and Users.`,
    Markup.inlineKeyboard([
      [Markup.button.callback("🎯 Manage targets", "admin:rewards")],
      [Markup.button.callback("⬅️ Admin menu", "admin:home")],
    ]),
  );
}

async function broadcastAdminView(ctx: BotContext) {
  await setSession(telegramId(ctx), "broadcast_content");
  await safeEdit(ctx, "📢 <b>Broadcast</b>\n\nSend text, photo, video, GIF, document or file now. I will prepare a preview before anything is sent.\n\nSend /cancel to leave this flow.");
}

async function startAdminFlow(ctx: BotContext, state: string, text: string) {
  await setSession(telegramId(ctx), state);
  await safeEdit(ctx, text);
}

async function adminCallback(ctx: BotContext, data: string) {
  if (!(await isAdmin(telegramId(ctx)))) {
    await safeEdit(ctx, "⛔ This action is restricted to authorized admins.");
    return;
  }
  await animateTransition(ctx, "🛡️");
  const parts = data.split(":");
  const action = parts[1];
  const id = parts[2];
  if (action === "home") return adminHome(ctx);
  if (action === "dashboard") return dashboardView(ctx);
  if (action === "rewards") return rewardsAdminView(ctx);
  if (action === "channels") return channelsAdminView(ctx);
  if (action === "content") return contentAdminView(ctx);
  if (action === "broadcast") return broadcastAdminView(ctx);
  if (action === "settings") return settingsAdminView(ctx);
  if (action === "admins") return adminsAdminView(ctx);
  if (action === "logs") return logsAdminView(ctx);
  if (action === "users") return usersAdminView(ctx);
  if (action === "referrals") return referralsAdminView(ctx);
  if (action === "stock") return stockAdminView(ctx);
  if (action === "delivery_history") return deliveryHistoryView(ctx);
  if (action === "add_reward") return startAdminFlow(ctx, "reward_milestone", "🎁 Send the milestone ID for this reward.\n\nExample: 1");
  if (action === "add_milestone") return startAdminFlow(ctx, "milestone_create", "🎯 Send milestone as: Name | required referrals\n\nExample: Starter reward | 5");
  if (action === "add_channel") return startAdminFlow(ctx, "channel_chat_id", "🔒 Send the channel chat ID.\n\nThe bot must be an administrator in the channel.");
  if (action === "add_admin") {
    if (telegramId(ctx) !== OWNER_ID) return safeEdit(ctx, "⛔ Only the owner can add admins.");
    return startAdminFlow(ctx, "admin_add", "🛡️ Send the new admin's Telegram User ID.");
  }
  if (action === "content_edit") {
    const key = parts.slice(2).join(":");
    await setSession(telegramId(ctx), `content_edit:${key}`);
    return safeEdit(ctx, `📝 <b>${key}</b>\n\nCurrent content:\n${await getContent(key)}\n\nSend the new text now, or /cancel.`);
  }
  if (action === "maintenance_toggle") {
    const value = (await getSetting("maintenance_enabled")) === "true" ? "false" : "true";
    await setSetting("maintenance_enabled", value);
    await audit(telegramId(ctx), "maintenance_changed", "setting", "maintenance_enabled", { value });
    return settingsAdminView(ctx);
  }
  if (action === "disclaimer_toggle") {
    const value = (await getSetting("disclaimer_enabled")) === "true" ? "false" : "true";
    await setSetting("disclaimer_enabled", value);
    await audit(telegramId(ctx), "disclaimer_setting_changed", "setting", "disclaimer_enabled", { value });
    return settingsAdminView(ctx);
  }
  if (action === "referrals_toggle") {
    const value = (await getSetting("referral_enabled")) === "true" ? "false" : "true";
    await setSetting("referral_enabled", value);
    await audit(telegramId(ctx), "referral_setting_changed", "setting", "referral_enabled", { value });
    return settingsAdminView(ctx);
  }
  if (action === "support_edit") return startAdminFlow(ctx, "support_edit", "💬 Send the Support Bot URL, for example https://t.me/YourSupportBot");
  if (action === "channel_toggle") {
    const channelId = Number(id);
    const rows = await db.select().from(forceSubscribeChannelsTable).where(eq(forceSubscribeChannelsTable.id, channelId)).limit(1);
    if (rows[0]) await db.update(forceSubscribeChannelsTable).set({ enabled: !rows[0].enabled }).where(eq(forceSubscribeChannelsTable.id, channelId));
    await audit(telegramId(ctx), "force_channel_toggled", "channel", id);
    return channelsAdminView(ctx);
  }
  if (action === "channel_edit") {
    const channel = await db.select().from(forceSubscribeChannelsTable).where(eq(forceSubscribeChannelsTable.id, Number(id))).limit(1);
    if (!channel[0]) return channelsAdminView(ctx);
    return startAdminFlow(ctx, `channel_edit:${id}`, `✏️ Current channel: ${channel[0].title}\n${channel[0].inviteLink}\n\nSend the update as: Title | Invite link`);
  }
  if (action === "channel_up" || action === "channel_down") {
    const current = await db.select().from(forceSubscribeChannelsTable).where(eq(forceSubscribeChannelsTable.id, Number(id))).limit(1);
    if (current[0]) {
      const direction = action === "channel_up" ? -1 : 1;
      const neighbor = await db
        .select()
        .from(forceSubscribeChannelsTable)
        .where(eq(forceSubscribeChannelsTable.sortOrder, current[0].sortOrder + direction))
        .limit(1);
      if (neighbor[0]) {
        await db.transaction(async (tx) => {
          await tx.update(forceSubscribeChannelsTable).set({ sortOrder: -999999 }).where(eq(forceSubscribeChannelsTable.id, current[0].id));
          await tx.update(forceSubscribeChannelsTable).set({ sortOrder: current[0].sortOrder }).where(eq(forceSubscribeChannelsTable.id, neighbor[0].id));
          await tx.update(forceSubscribeChannelsTable).set({ sortOrder: neighbor[0].sortOrder }).where(eq(forceSubscribeChannelsTable.id, current[0].id));
        });
        await audit(telegramId(ctx), "force_channel_reordered", "channel", id, { direction: action });
      }
    }
    return channelsAdminView(ctx);
  }
  if (action === "channel_delete") {
    return safeEdit(
      ctx,
      "⚠️ <b>Delete this Force Subscribe channel?</b>\n\nUsers will no longer be asked to join it.",
      Markup.inlineKeyboard([
        [Markup.button.callback("🗑️ Confirm delete", `admin:channel_delete_confirm:${id}`)],
        [Markup.button.callback("Cancel", "admin:channels")],
      ]),
    );
  }
  if (action === "channel_delete_confirm") {
    await db.delete(forceSubscribeChannelsTable).where(eq(forceSubscribeChannelsTable.id, Number(id)));
    await audit(telegramId(ctx), "force_channel_deleted", "channel", id);
    return channelsAdminView(ctx);
  }
  if (action === "milestone_toggle") {
    const milestoneId = Number(id);
    const rows = await db.select().from(milestonesTable).where(eq(milestonesTable.id, milestoneId)).limit(1);
    if (rows[0]) await db.update(milestonesTable).set({ enabled: !rows[0].enabled }).where(eq(milestonesTable.id, milestoneId));
    await audit(telegramId(ctx), "milestone_toggled", "milestone", id);
    return rewardsAdminView(ctx);
  }
  if (action === "milestone_edit") {
    return startAdminFlow(ctx, `milestone_edit:${id}`, "🎯 Send the updated milestone as: Name | required referrals");
  }
  if (action === "milestone_delete") {
    return safeEdit(
      ctx,
      "⚠️ <b>Delete this milestone?</b>\n\nExisting reward inventory for it will stay in history but no new claims will be created.",
      Markup.inlineKeyboard([
        [Markup.button.callback("🗑️ Confirm delete", `admin:milestone_delete_confirm:${id}`)],
        [Markup.button.callback("Cancel", "admin:rewards")],
      ]),
    );
  }
  if (action === "milestone_delete_confirm") {
    await db.update(milestonesTable).set({ enabled: false }).where(eq(milestonesTable.id, Number(id)));
    await audit(telegramId(ctx), "milestone_deleted", "milestone", id);
    return rewardsAdminView(ctx);
  }
  if (action === "reward_toggle") {
    const reward = await db.select().from(rewardInventoryTable).where(eq(rewardInventoryTable.id, Number(id))).limit(1);
    if (reward[0] && (reward[0].status === "available" || reward[0].status === "disabled")) {
      await db.update(rewardInventoryTable).set({ status: reward[0].status === "available" ? "disabled" : "available" }).where(eq(rewardInventoryTable.id, Number(id)));
      await audit(telegramId(ctx), "reward_toggled", "reward", id);
    }
    return rewardsAdminView(ctx);
  }
  if (action === "reward_edit") {
    return startAdminFlow(ctx, `reward_edit:${id}`, "✏️ Send replacement reward content. You can send text, JSON, a link, photo, video, GIF, document, APK or another Telegram-supported file.");
  }
  if (action === "reward_delete") {
    return safeEdit(
      ctx,
      "⚠️ <b>Remove this reward from active inventory?</b>\n\nIt will be disabled rather than erased, preserving delivery history.",
      Markup.inlineKeyboard([
        [Markup.button.callback("🗑️ Confirm remove", `admin:reward_delete_confirm:${id}`)],
        [Markup.button.callback("Cancel", "admin:rewards")],
      ]),
    );
  }
  if (action === "reward_delete_confirm") {
    await db.update(rewardInventoryTable).set({ status: "disabled" }).where(eq(rewardInventoryTable.id, Number(id)));
    await audit(telegramId(ctx), "reward_removed", "reward", id);
    return rewardsAdminView(ctx);
  }
  if (action === "confirm_broadcast") {
    const session = await getSession(telegramId(ctx));
    const payload = session?.payload as MediaPayload | undefined;
    if (!payload) return safeEdit(ctx, "Broadcast draft expired. Start again.");
    const users = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.banned, false));
    const inserted = await db.insert(broadcastsTable).values({
      adminTelegramId: telegramId(ctx),
      contentType: payload.contentType,
      payload,
      total: users.length,
      status: "queued",
    }).returning({ id: broadcastsTable.id });
    if (inserted[0]) {
      await db.insert(broadcastJobsTable).values(users.map((user) => ({ broadcastId: inserted[0].id, userId: user.id })));
      await clearSession(telegramId(ctx));
      await audit(telegramId(ctx), "broadcast_queued", "broadcast", String(inserted[0].id), { total: users.length });
      await safeEdit(ctx, `📢 <b>Broadcast queued</b>\n\nRecipients: <b>${users.length}</b>\nThe queue is now processing with rate-limit protection.`);
      const activeBot = ctx.state.bot as Telegraf<BotContext> | undefined;
      if (activeBot) void runBroadcast(activeBot, inserted[0].id);
    }
    return;
  }
  if (action === "user_ban") {
    return safeEdit(
      ctx,
      "⚠️ <b>Change this user's ban status?</b>",
      Markup.inlineKeyboard([
        [Markup.button.callback("✅ Confirm", `admin:user_ban_confirm:${id}`)],
        [Markup.button.callback("Cancel", `admin:user_detail:${id}`)],
      ]),
    );
  }
  if (action === "user_ban_confirm") {
    const user = await getUserByTelegramId(id);
    if (user) {
      await db.update(usersTable).set({ banned: !user.banned }).where(eq(usersTable.id, user.id));
      await audit(telegramId(ctx), user.banned ? "user_unbanned" : "user_banned", "user", id);
    }
    return userAdminDetail(ctx, id);
  }
  if (action === "user_reset") {
    return safeEdit(
      ctx,
      "⚠️ <b>Reset this user's progress?</b>\n\nReferrals and points will be set to zero and the adjustment will be logged.",
      Markup.inlineKeyboard([
        [Markup.button.callback("♻️ Confirm reset", `admin:user_reset_confirm:${id}`)],
        [Markup.button.callback("Cancel", `admin:user_detail:${id}`)],
      ]),
    );
  }
  if (action === "user_reset_confirm") {
    const user = await getUserByTelegramId(id);
    if (user) {
      await db.transaction(async (tx) => {
        await tx.update(usersTable).set({ referralCount: 0, points: 0 }).where(eq(usersTable.id, user.id));
        await tx.insert(referralHistoryTable).values({ userId: user.id, adminTelegramId: telegramId(ctx), delta: -user.referralCount, reason: "Admin reset progress" });
        await tx.insert(pointHistoryTable).values({ userId: user.id, adminTelegramId: telegramId(ctx), delta: -user.points, reason: "Admin reset progress" });
      });
      await audit(telegramId(ctx), "user_progress_reset", "user", id);
    }
    return userAdminDetail(ctx, id);
  }
  if (action === "user_detail") return userAdminDetail(ctx, id);
  if (action === "user_amount") {
    const operation = parts[2];
    const userId = parts[3];
    return startAdminFlow(ctx, `user_amount:${operation}:${userId}`, "Send the integer amount to apply.");
  }
}

async function handleAdminText(ctx: BotContext, text: string) {
  const userId = telegramId(ctx);
  const session = await getSession(userId);
  if (!session) return false;
  if (text === "/cancel") {
    await clearSession(userId);
    await adminHome(ctx);
    return true;
  }
  const payload = session.payload as SessionPayload;
  if (session.state === "user_search") {
    await clearSession(userId);
    await userAdminDetail(ctx, text.trim());
    return true;
  }
  if (session.state === "reward_milestone") {
    const milestoneId = Number(text.trim());
    const milestone = await db.select({ id: milestonesTable.id }).from(milestonesTable).where(eq(milestonesTable.id, milestoneId)).limit(1);
    if (!milestone[0]) {
      await ctx.reply("That milestone ID does not exist. Send a valid ID.");
      return true;
    }
    await setSession(userId, "reward_content", { milestoneId });
    await ctx.reply("📎 Now send the reward content: text, code, JSON, link, photo, video, GIF, document, APK or any Telegram-supported file.");
    return true;
  }
  if (session.state === "reward_content") {
    if (text === "/done") {
      await clearSession(userId);
      await ctx.reply("✅ Bulk reward upload complete.");
      return true;
    }
    const reward = capturePayload(ctx);
    const milestoneId = Number(payload.milestoneId);
    await db.insert(rewardInventoryTable).values({ milestoneId, ...reward, metadata: { addedBy: userId } });
    await audit(userId, "reward_added", "milestone", String(milestoneId), { contentType: reward.contentType });
    await setSession(userId, "reward_content", { milestoneId });
    await ctx.reply("✅ Reward stored securely. Send another for this milestone, or /done to finish bulk upload.");
    return true;
  }
  if (session.state === "milestone_create") {
    const [name, target] = text.split("|").map((part) => part.trim());
    const referralsRequired = Number(target);
    if (!name || !Number.isInteger(referralsRequired) || referralsRequired < 1) {
      await ctx.reply("Use exactly: Name | positive referral count");
      return true;
    }
    await db.insert(milestonesTable).values({ name, referralsRequired, sortOrder: referralsRequired });
    await clearSession(userId);
    await audit(userId, "milestone_created", "milestone", name, { referralsRequired });
    await ctx.reply("✅ Milestone created.");
    return true;
  }
  if (session.state.startsWith("milestone_edit:")) {
    const milestoneId = Number(session.state.split(":")[1]);
    const [name, target] = text.split("|").map((part) => part.trim());
    const referralsRequired = Number(target);
    if (!name || !Number.isInteger(referralsRequired) || referralsRequired < 1) {
      await ctx.reply("Use exactly: Name | positive referral count");
      return true;
    }
    await db.update(milestonesTable).set({ name, referralsRequired }).where(eq(milestonesTable.id, milestoneId));
    await clearSession(userId);
    await audit(userId, "milestone_updated", "milestone", String(milestoneId), { referralsRequired });
    await ctx.reply("✅ Milestone updated.");
    return true;
  }
  if (session.state === "channel_chat_id") {
    await setSession(userId, "channel_title", { chatId: text.trim() });
    await ctx.reply("Send the channel display title.");
    return true;
  }
  if (session.state === "channel_title") {
    await setSession(userId, "channel_link", { chatId: String(payload.chatId), title: text.trim() });
    await ctx.reply("Send the public invite link, for example https://t.me/yourchannel");
    return true;
  }
  if (session.state === "channel_link") {
    const existing = await db.select({ count: sql<number>`count(*)` }).from(forceSubscribeChannelsTable);
    await db.insert(forceSubscribeChannelsTable).values({
      chatId: String(payload.chatId),
      title: String(payload.title),
      inviteLink: text.trim(),
      sortOrder: Number(existing[0]?.count ?? 0),
    });
    await clearSession(userId);
    await audit(userId, "force_channel_added", "channel", String(payload.chatId));
    await ctx.reply("✅ Force Subscribe channel added.");
    return true;
  }
  if (session.state.startsWith("channel_edit:")) {
    const channelId = Number(session.state.split(":")[1]);
    const [title, link] = text.split("|").map((part) => part.trim());
    if (!title || !link) {
      await ctx.reply("Use exactly: Title | Invite link");
      return true;
    }
    await db.update(forceSubscribeChannelsTable).set({ title, inviteLink: link }).where(eq(forceSubscribeChannelsTable.id, channelId));
    await clearSession(userId);
    await audit(userId, "force_channel_updated", "channel", String(channelId));
    await ctx.reply("✅ Channel updated.");
    return true;
  }
  if (session.state === "admin_add") {
    if (userId !== OWNER_ID || !/^\d+$/.test(text.trim())) {
      await ctx.reply("Only the owner can add a numeric Telegram User ID.");
      return true;
    }
    await db.insert(adminsTable).values({ telegramId: text.trim(), role: "admin", permissions: ["dashboard", "users", "rewards"], active: true }).onConflictDoUpdate({
      target: adminsTable.telegramId,
      set: { active: true },
    });
    await clearSession(userId);
    await audit(userId, "admin_added", "admin", text.trim());
    await ctx.reply("✅ Admin authorized.");
    return true;
  }
  if (session.state === "support_edit") {
    await setSetting("support_link", text.trim());
    await clearSession(userId);
    await audit(userId, "support_link_changed", "setting", "support_link");
    await ctx.reply("✅ Support Bot link updated.");
    return true;
  }
  if (session.state.startsWith("content_edit:")) {
    const key = session.state.slice("content_edit:".length);
    await setContent(key, text);
    await clearSession(userId);
    await audit(userId, "content_updated", "content", key);
    await ctx.reply(`✅ ${key} updated.`);
    return true;
  }
  if (session.state.startsWith("reward_edit:")) {
    const rewardId = Number(session.state.split(":")[1]);
    const reward = capturePayload(ctx);
    await db.update(rewardInventoryTable).set({
      contentType: reward.contentType,
      textContent: reward.textContent ?? null,
      fileId: reward.fileId ?? null,
      fileName: reward.fileName ?? null,
      mimeType: reward.mimeType ?? null,
      caption: reward.caption ?? null,
    }).where(eq(rewardInventoryTable.id, rewardId));
    await clearSession(userId);
    await audit(userId, "reward_updated", "reward", String(rewardId), { contentType: reward.contentType });
    await ctx.reply("✅ Reward updated.");
    return true;
  }
  if (session.state.startsWith("user_amount:")) {
    const [, operation, targetId] = session.state.split(":");
    const amount = Number(text.trim());
    const target = await getUserByTelegramId(targetId);
    if (!target || !Number.isInteger(amount) || amount < 0) {
      await ctx.reply("Send a valid non-negative integer amount.");
      return true;
    }
    const sign = operation.endsWith("remove") ? -1 : 1;
    if (operation.startsWith("points")) {
      await db.transaction(async (tx) => {
        await tx.update(usersTable).set({ points: sql`${usersTable.points} + ${sign * amount}` }).where(eq(usersTable.id, target.id));
        await tx.insert(pointHistoryTable).values({ userId: target.id, adminTelegramId: userId, delta: sign * amount, reason: "Manual admin adjustment" });
      });
    } else {
      await db.transaction(async (tx) => {
        await tx.update(usersTable).set({ referralCount: sql`${usersTable.referralCount} + ${sign * amount}` }).where(eq(usersTable.id, target.id));
        await tx.insert(referralHistoryTable).values({ userId: target.id, adminTelegramId: userId, delta: sign * amount, reason: "Manual admin adjustment" });
      });
    }
    await clearSession(userId);
    await audit(userId, "manual_user_adjustment", "user", targetId, { operation, amount });
    await userAdminDetail(ctx, targetId);
    return true;
  }
  if (session.state === "broadcast_content") {
    const captured = capturePayload(ctx);
    await setSession(userId, "broadcast_confirm", captured);
    await safeEdit(ctx, `📢 <b>Broadcast Preview</b>\n\n${formatPayload(captured)}\n\nThis is a preview only. Send to all non-banned users?`, Markup.inlineKeyboard([
      [Markup.button.callback("✅ Confirm & Queue", "admin:confirm_broadcast")],
      [Markup.button.callback("✖️ Cancel", "admin:home")],
    ]));
    return true;
  }
  return false;
}

export async function startTelegramBot() {
  if (!BOT_TOKEN) {
    logger.warn("TELEGRAM_BOT_TOKEN is missing; Telegram bot was not started");
    return;
  }
  logger.info("Preparing Telegram bot database defaults");
  await seedDefaults();
  logger.info("Telegram bot database defaults ready");
  const bot = new Telegraf<BotContext>(BOT_TOKEN);
  bot.use(async (ctx, next) => {
    try {
      if (ctx.from) await ensureUser(ctx);
      ctx.state.bot = bot;
      await next();
    } catch (error) {
      logger.error({ error }, "Telegram update failed");
      await ctx.reply("Something went wrong while processing that request. Please try again.").catch(() => undefined);
    }
  });
  bot.start(async (ctx) => {
    const text = "text" in ctx.message ? ctx.message.text : "";
    await handleStart(ctx, text.split(" ")[1] ?? "");
  });
  bot.command("admin", adminHome);
  bot.hears(MAIN_BUTTONS.referrals, async (ctx) => {
    await animateTransition(ctx, "👥");
    return referralView(ctx);
  });
  bot.hears(MAIN_BUTTONS.rewards, async (ctx) => {
    await animateTransition(ctx, "🎁");
    return rewardsView(ctx);
  });
  bot.hears(MAIN_BUTTONS.progress, async (ctx) => {
    await animateTransition(ctx, "📊");
    return progressView(ctx);
  });
  bot.hears(MAIN_BUTTONS.support, async (ctx) => {
    await animateTransition(ctx, "💬");
    return supportView(ctx);
  });
  bot.hears(ADMIN_BUTTON, async (ctx) => {
    await animateTransition(ctx, "🛡️");
    return adminHome(ctx);
  });
  bot.on("callback_query", async (ctx) => {
    if (!("data" in ctx.callbackQuery)) return;
    await answer(ctx, "✨ Opening...");
    const data = ctx.callbackQuery.data;
    if (data === "access:check") return handleSubscriptionCheck(ctx);
    if (data === "disclaimer:accept") return handleDisclaimerAccept(ctx);
    if (data === "user:home") {
      await animateTransition(ctx, "🏠");
      return renderMain(ctx);
    }
    if (data === "user:referrals") {
      await animateTransition(ctx, "👥");
      return referralView(ctx);
    }
    if (data === "user:rewards") {
      await animateTransition(ctx, "🎁");
      return rewardsView(ctx);
    }
    if (data === "user:progress") {
      await animateTransition(ctx, "📊");
      return progressView(ctx);
    }
    if (data === "user:support") {
      await animateTransition(ctx, "💬");
      return supportView(ctx);
    }
    if (data.startsWith("admin:")) return adminCallback(ctx, data);
  });
  bot.on("message", async (ctx) => {
    const message = incomingMessage(ctx);
    if (message.text && (await handleAdminText(ctx, message.text))) return;
    if (message.text?.startsWith("/")) return;
    if (await isMaintenanceBlocked(ctx)) {
      await ctx.reply(await getContent("maintenance"));
      return;
    }
    const user = await ensureUser(ctx);
    if (!user.disclaimerAcceptedAt && (await getSetting("disclaimer_enabled")) === "true") {
      await renderAccessGate(ctx, user);
      return;
    }
    await ctx.reply(
      "Please choose an option from the menu below.",
      buildMainKeyboard(await isAdmin(user.telegramId)),
    );
  });
  bot.catch((error) => logger.error({ error }, "Telegram bot error"));
  logger.info("Connecting to Telegram polling API");
  void bot
    .launch({ dropPendingUpdates: true })
    .catch((error) => logger.error({ error }, "Telegram polling failed"));
  logger.info("Telegram Refer & Reward bot started");
  const stop = (signal: string) => {
    logger.info({ signal }, "Stopping Telegram bot");
    bot.stop(signal);
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));
}
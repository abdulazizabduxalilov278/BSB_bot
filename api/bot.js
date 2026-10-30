const { Telegraf, Markup } = require('telegraf');
const { message } = require('telegraf/filters');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

const bot = new Telegraf(process.env.BOT_TOKEN);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// 👑 VIP FOYDALANUVCHILAR RO'YXATI
// Shu yerga vergul bilan mijozlarning ID larini qo'shib borasiz
const VIP_USERS = [609227381];

// 👨‍💻 ADMIN ID RAQAMI
const ADMIN_ID = 8067736506;

// 📊 KUNLIK GEMINI PRO LIMITLARI
const DAILY_LIMIT_FREE = 10;
const DAILY_LIMIT_VIP = 40;

// ⏱️ COOLDOWN SOZLAMALARI (soniyalarda)
const COOLDOWN_FREE = 10; // Oddiy foydalanuvchilar uchun 10 sekund
const COOLDOWN_VIP = 3;   // VIP foydalanuvchilar uchun 3 sekund

// 🤖 MODEL PRIORITET RO'YXATI (avtomatik fallback)
// Google yangi model chiqarsa — shu ro'yxat boshiga qo'shing, shu kifoya!
const PRO_MODELS = [
  'gemini-2.5-pro-preview-05-06',
  'gemini-2.0-pro-exp',
  'gemini-1.5-pro-latest',
  'gemini-1.5-pro',
];
const FLASH_MODELS = [
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-1.5-flash-latest',
  'gemini-1.5-flash',
];

// ⏱️ COOLDOWN TEKSHIRUVI
const userLastMessageTime = new Map();

function checkCooldown(userId) {
  const isVIP = VIP_USERS.includes(userId);
  const cooldownSec = isVIP ? COOLDOWN_VIP : COOLDOWN_FREE;
  const now = Date.now();
  const lastTime = userLastMessageTime.get(userId) || 0;
  const elapsed = (now - lastTime) / 1000;

  if (elapsed < cooldownSec) {
    const remaining = Math.ceil(cooldownSec - elapsed);
    return { limited: true, remaining, isVIP };
  }

  userLastMessageTime.set(userId, now);

  // Keshni tozalab turish (xotira to'lib ketmasligi uchun)
  if (userLastMessageTime.size > 1000) {
    for (const [uid, time] of userLastMessageTime.entries()) {
      if (now - time > 60000) userLastMessageTime.delete(uid);
    }
  }

  return { limited: false, isVIP };
}

// 🔁 TAKRORIY XABARLARNING OLDINI OLISH (Telegram webhook retry himoyasi)
const processedUpdates = new Set();
const MAX_CACHE_SIZE = 500;

function isDuplicateUpdate(updateId) {
  if (processedUpdates.has(updateId)) return true;
  processedUpdates.add(updateId);
  if (processedUpdates.size > MAX_CACHE_SIZE) {
    const first = processedUpdates.values().next().value;
    processedUpdates.delete(first);
  }
  return false;
}

function todayString() {
  return new Date().toISOString().slice(0, 10);
}

// 📈 Bugungi foydalanish sonini olish
async function getTodayUsage(userId) {
  const today = todayString();
  const { data, error } = await supabase
    .from('usage_limits')
    .select('pro_count')
    .eq('user_id', userId)
    .eq('usage_date', today)
    .maybeSingle();

  if (error) {
    console.error('Supabase getTodayUsage xatosi:', error.message);
    return 0;
  }
  return data ? data.pro_count : 0;
}

// ➕ Foydalanishni +1 oshirish
async function incrementUsage(userId) {
  const today = todayString();
  const current = await getTodayUsage(userId);

  const { error } = await supabase
    .from('usage_limits')
    .upsert(
      { user_id: userId, usage_date: today, pro_count: current + 1 },
      { onConflict: 'user_id,usage_date' }
    );

  if (error) console.error('Supabase incrementUsage xatosi:', error.message);
}

// 💾 Savol-javobni tarixga saqlash
async function saveHistory(userId, question, answer) {
  const { error } = await supabase
    .from('chat_history')
    .insert({ user_id: userId, question, answer: answer.substring(0, 2000) });

  if (error) console.error('Supabase saveHistory xatosi:', error.message);
}

// 📜 Oxirgi N ta tarixni olish
async function getHistory(userId, limit = 5) {
  const { data, error } = await supabase
    .from('chat_history')
    .select('question, answer, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('Supabase getHistory xatosi:', error.message);
    return [];
  }
  return data || [];
}

// ⌨️ "Yozyapti..." statusini uzluksiz ko'rsatish
function startTypingLoop(ctx) {
  ctx.sendChatAction('typing').catch(() => {});
  const interval = setInterval(() => {
    ctx.sendChatAction('typing').catch(() => {});
  }, 4000);
  return () => clearInterval(interval);
}

async function urlToGenerativePart(url, mimeType) {
  const response = await axios.get(url, { responseType: 'arraybuffer' });
  return {
    inlineData: {
      data: Buffer.from(response.data).toString('base64'),
      mimeType
    },
  };
}

// 🔄 SMART RETRY + FALLBACK
// 503/429 bo'lsa — ro'yxatdagi keyingi modelga avtomatik o'tadi
// Yangi model chiqsa — PRO_MODELS/FLASH_MODELS boshiga qo'shing
async function generateWithRetry(modelsList, contents) {
  let lastError;

  for (const tryModelName of modelsList) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const model = genAI.getGenerativeModel({ model: tryModelName });
        const result = await model.generateContent(contents);
        return { result, usedModel: tryModelName };
      } catch (err) {
        lastError = err;
        const isRetryable = err.message && (
          err.message.includes('503') ||
          err.message.includes('Service Unavailable') ||
          err.message.includes('overloaded') ||
          err.message.includes('high demand') ||
          err.message.includes('429') ||
          err.message.includes('rate limit') ||
          err.message.includes('quota')
        );

        if (isRetryable && attempt < 2) {
          await new Promise(r => setTimeout(r, 1200));
          continue;
        }
        // Retry o'tmadi yoki boshqa xatolik — keyingi modelga
        break;
      }
    }
  }

  throw lastError;
}

// 🧠 Qaysi modellar ro'yxatini ishlatish
async function resolveModel(userId) {
  const isVIP = VIP_USERS.includes(userId);
  const limit = isVIP ? DAILY_LIMIT_VIP : DAILY_LIMIT_FREE;
  const usage = await getTodayUsage(userId);

  if (usage < limit) {
    return { models: PRO_MODELS, isVIP, usedPro: true, usage, limit };
  }
  return { models: FLASH_MODELS, isVIP, usedPro: false, usage, limit };
}

// 🤖 AI uchun umumiy prompt qolip
function buildPrompt(userText, isImage = false) {
  return (
    `Sen BSB, CHSB va barcha fanlar bo'yicha aqlli AI yordamchisan.\n` +
    `MUHIM qoidalar:\n` +
    `📌 Faqat o'zbek tilida javob ber\n` +
    `📌 Qisqa va tushunarli yoz (300 so'zdan oshmasin)\n` +
    `📌 Har bir qadam/fikrga emoji qo'y\n` +
    `📌 Muhim so'zlarni *yulduzcha* bilan ajrat\n` +
    `📌 Javob oxirida 1 qatorlik xulosa ber\n\n` +
    (isImage ? `🖼️ Rasmdagi vazifani yech:\n` : `❓ Savol: `) +
    userText
  );
}

// ═══════════════════════════════════════════════
//                    BOT HANDLERLAR
// ═══════════════════════════════════════════════

bot.start((ctx) => {
  ctx.reply(
    '👋 *Assalomu alaykum!* Botga xush kelibsiz\\.\n\n📚 BSB, CHSB va istalgan fandan yordam beraman\\!\n\nQuyidagi bo\'limlardan birini tanlang:',
    {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('ℹ️ Bot haqida', 'about_bot')],
        [Markup.button.callback('💎 VIP obuna', 'donate_vip')],
        [Markup.button.callback('🆔 Mening ID raqamim', 'get_id')],
        [Markup.button.callback('📜 Mening tarixim', 'view_history')],
        [Markup.button.callback('👨‍💻 Admin bilan bog\'lanish', 'contact_admin')],
        [Markup.button.callback('🚀 Savol berish', 'start_asking')]
      ])
    }
  );
});

bot.action('about_bot', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
    '📚 *Bot nima uchun?*\n\n' +
    '🔹 BSB, CHSB va istalgan fan bo\'yicha murakkab masalalar\n' +
    '🔹 Rasmli masalalarni ham yechamiz\n' +
    '🔹 O\'zbek tilida aniq va tez javob',
    { parse_mode: 'Markdown' }
  );
});

bot.action('donate_vip', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
    `💎 *VIP obuna imtiyozlari:*\n\n` +
    `⚡ Kutish vaqti: atigi *${COOLDOWN_VIP} soniya* (oddiylarda ${COOLDOWN_FREE}s)\n` +
    `🧠 Kuniga *${DAILY_LIMIT_VIP} marta* kuchli Pro model\n` +
    `👑 VIP nishon va ustuvor xizmat\n\n` +
    `💳 VIP olish uchun: @XAVIK_ORG`,
    { parse_mode: 'Markdown' }
  );
});

bot.action('get_id', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  await ctx.reply(
    `🆔 *Sizning ID raqamingiz:*\n\n\`${userId}\`\n\n_(Ustiga bossangiz — nusxalanadi 📋)_`,
    { parse_mode: 'Markdown' }
  );
});

bot.action('contact_admin', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('👨‍💻 *Admin:* @XAVIK_ORG', { parse_mode: 'Markdown' });
});

bot.action('start_asking', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
    '🚀 *Bot tayyor!*\n\nSavol yozing yoki masala rasmini yuboring 👇',
    { parse_mode: 'Markdown' }
  );
});

// 📜 TARIXNI KO'RSATISH
bot.action('view_history', async (ctx) => {
  await ctx.answerCbQuery();
  try {
    const history = await getHistory(ctx.from.id, 5);

    if (!history.length) {
      return ctx.reply('📭 Hali savol tarixi yo\'q. Birinchi savolingizni yuboring!');
    }

    let text = '📜 *Oxirgi savollaringiz:*\n\n';
    history.forEach((item, i) => {
      const date = new Date(item.created_at).toLocaleString('uz-UZ');
      const shortQ = item.question.length > 80 ? item.question.substring(0, 80) + '...' : item.question;
      const shortA = item.answer.length > 150 ? item.answer.substring(0, 150) + '...' : item.answer;
      text += `*${i + 1}. ${date}*\n❓ ${shortQ}\n💡 ${shortA}\n\n`;
    });

    if (text.length > 4000) text = text.substring(0, 4000) + '\n\n...(qisqartirildi)';
    await ctx.reply(text, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error(error);
    await ctx.reply('❌ Tarixni olishda xatolik.');
  }
});

// 👑 ADMIN BUYRUG'I: VIP berish
// Ishlatilishi: /tabrik 123456789 Ism
// Natija: tabrik botda ko'rinadi (+ foydalanuvchi lichkasiga ham yuboriladi)
bot.command('tabrik', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;

  const parts = ctx.message.text.split(' ');

  if (parts.length < 2) {
    return ctx.reply(
      '⚠️ Format: `/tabrik 123456789 Ism`\n\nMasalan: `/tabrik 123456789 Abdulloh`',
      { parse_mode: 'Markdown' }
    );
  }

  const targetUserId = Number(parts[1]);
  const targetName = parts[2] || 'Aziz foydalanuvchi';

  // VIP ro'yxatiga sessiya ichida qo'shish
  if (!VIP_USERS.includes(targetUserId)) {
    VIP_USERS.push(targetUserId);
  }

  const tabrikText =
    `🎉 *Tabriklaymiz, ${targetName}!*\n\n` +
    `💎 *VIP obuna* muvaffaqiyatli ulandi!\n\n` +
    `✅ *Sizning imtiyozlaringiz:*\n` +
    `👑 Eng kuchli Pro AI modeli\n` +
    `⚡ Atigi ${COOLDOWN_VIP} soniya kutish\n` +
    `🧠 Kuniga ${DAILY_LIMIT_VIP} marta Pro AI\n\n` +
    `🚀 Istalgan savol yoki masalangizni yuboring!`;

  try {
    // Botda (admin chatida) ko'rsatish
    await ctx.reply(tabrikText, { parse_mode: 'Markdown' });
    // Foydalanuvchi lichkasiga ham yuborish (ixtiyoriy)
    await ctx.telegram.sendMessage(targetUserId, tabrikText, { parse_mode: 'Markdown' }).catch(() => {});
  } catch (error) {
    await ctx.reply(`❌ Xatolik: ${error.message}`);
  }
});

// 📝 MATNLI SAVOLLAR
bot.on(message('text'), async (ctx) => {
  const text = ctx.message.text;
  if (text.startsWith('/')) return;

  const cooldown = checkCooldown(ctx.from.id);
  if (cooldown.limited) {
    return ctx.reply(
      `⏳ *Biroz kuting!*\n\nYana *${cooldown.remaining}* soniya...${
        !cooldown.isVIP ? '\n\n💎 VIP da atigi 3 soniya kutiladi!' : ''
      }`,
      { parse_mode: 'Markdown' }
    );
  }

  const stopTyping = startTypingLoop(ctx);

  try {
    const { models, isVIP, usedPro, usage, limit } = await resolveModel(ctx.from.id);
    const prompt = buildPrompt(text);

    const { result, usedModel } = await generateWithRetry(models, prompt);
    const answer = await result.response.text();

    const badge = usedPro
      ? (isVIP ? `👑 *VIP Pro* \\[${usage + 1}/${limit}\\]` : `🧠 *Pro* \\[${usage + 1}/${limit}\\]`)
      : `⚡ *Tezkor* \\[limit tugadi\\]`;

    const replyText = `${badge}\n\n${answer}`;

    stopTyping();

    if (usedPro) await incrementUsage(ctx.from.id);

    if (replyText.length > 4000) {
      await ctx.reply(replyText.substring(0, 4000) + '\n\n_...qisqartirildi_', { parse_mode: 'MarkdownV2' });
    } else {
      await ctx.reply(replyText, { parse_mode: 'MarkdownV2' }).catch(() => ctx.reply(answer));
    }

    saveHistory(ctx.from.id, text, answer).catch(() => {});
  } catch (error) {
    stopTyping();
    console.error(error);
    await ctx.reply(`❌ Xatolik: ${error.message}`);
  }
});

// 🖼️ RASMLI SAVOLLAR
bot.on(message('photo'), async (ctx) => {
  const cooldown = checkCooldown(ctx.from.id);
  if (cooldown.limited) {
    return ctx.reply(
      `⏳ *Biroz kuting!*\n\nYana *${cooldown.remaining}* soniya...${
        !cooldown.isVIP ? '\n\n💎 VIP da atigi 3 soniya kutiladi!' : ''
      }`,
      { parse_mode: 'Markdown' }
    );
  }

  const stopTyping = startTypingLoop(ctx);

  try {
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const fileLink = await ctx.telegram.getFileLink(photo.file_id);
    const imagePart = await urlToGenerativePart(fileLink.href, 'image/jpeg');

    const { models, isVIP, usedPro, usage, limit } = await resolveModel(ctx.from.id);

    const userCaption = ctx.message.caption || 'Rasmdagi masalani yech';
    const prompt = buildPrompt(userCaption, true);

    const { result } = await generateWithRetry(models, [prompt, imagePart]);
    const answer = await result.response.text();

    const badge = usedPro
      ? (isVIP ? `👑 *VIP Pro* \\[${usage + 1}/${limit}\\]` : `🧠 *Pro* \\[${usage + 1}/${limit}\\]`)
      : `⚡ *Tezkor* \\[limit tugadi\\]`;

    const replyText = `${badge}\n\n${answer}`;

    stopTyping();

    if (usedPro) await incrementUsage(ctx.from.id);

    if (replyText.length > 4000) {
      await ctx.reply(replyText.substring(0, 4000) + '\n\n_...qisqartirildi_', { parse_mode: 'MarkdownV2' });
    } else {
      await ctx.reply(replyText, { parse_mode: 'MarkdownV2' }).catch(() => ctx.reply(answer));
    }

    saveHistory(ctx.from.id, `[Rasm] ${userCaption}`, answer).catch(() => {});
  } catch (error) {
    stopTyping();
    console.error(error);
    await ctx.reply(`❌ Rasmni o'qishda xatolik: ${error.message}`);
  }
});

module.exports = async (req, res) => {
  try {
    if (req.method === 'POST') {
      const update = req.body;

      if (update && update.update_id !== undefined && isDuplicateUpdate(update.update_id)) {
        return res.status(200).json({ ok: true, duplicate: true });
      }

      await bot.handleUpdate(update);
    }
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
};

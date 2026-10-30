const { Telegraf, Markup } = require('telegraf');
const { message } = require('telegraf/filters');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

const bot = new Telegraf(process.env.BOT_TOKEN);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// 👑 VIP FOYDALANUVCHILAR RO'YXATI
const VIP_USERS = [609227381];

// 👨‍💻 ADMIN ID
const ADMIN_ID = 8067736506;

// 📊 KUNLIK LIMITLAR
const DAILY_LIMIT_FREE = 10;
const DAILY_LIMIT_VIP = 40;

// ⏱️ COOLDOWN (soniyada)
const COOLDOWN_FREE = 10;
const COOLDOWN_VIP = 3;

// 🤖 MODEL PRIORITET RO'YXATI
// Yangi model chiqsa — ro'yxat boshiga qo'shing, shu kifoya!
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
    return { limited: true, remaining: Math.ceil(cooldownSec - elapsed), isVIP };
  }

  userLastMessageTime.set(userId, now);
  if (userLastMessageTime.size > 1000) {
    for (const [uid, time] of userLastMessageTime.entries()) {
      if (now - time > 60000) userLastMessageTime.delete(uid);
    }
  }
  return { limited: false, isVIP };
}

// 🔁 TAKRORIY XABARLARNING OLDINI OLISH
const processedUpdates = new Set();
const MAX_CACHE_SIZE = 500;

function isDuplicateUpdate(updateId) {
  if (processedUpdates.has(updateId)) return true;
  processedUpdates.add(updateId);
  if (processedUpdates.size > MAX_CACHE_SIZE) {
    processedUpdates.delete(processedUpdates.values().next().value);
  }
  return false;
}

function todayString() {
  return new Date().toISOString().slice(0, 10);
}

async function getTodayUsage(userId) {
  const { data, error } = await supabase
    .from('usage_limits')
    .select('pro_count')
    .eq('user_id', userId)
    .eq('usage_date', todayString())
    .maybeSingle();

  if (error) { console.error('getTodayUsage:', error.message); return 0; }
  return data ? data.pro_count : 0;
}

async function incrementUsage(userId) {
  const current = await getTodayUsage(userId);
  const { error } = await supabase
    .from('usage_limits')
    .upsert(
      { user_id: userId, usage_date: todayString(), pro_count: current + 1 },
      { onConflict: 'user_id,usage_date' }
    );
  if (error) console.error('incrementUsage:', error.message);
}

async function saveHistory(userId, question, answer) {
  const { error } = await supabase
    .from('chat_history')
    .insert({ user_id: userId, question, answer: answer.substring(0, 2000) });
  if (error) console.error('saveHistory:', error.message);
}

async function getHistory(userId, limit = 5) {
  const { data, error } = await supabase
    .from('chat_history')
    .select('question, answer, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) { console.error('getHistory:', error.message); return []; }
  return data || [];
}

function startTypingLoop(ctx) {
  ctx.sendChatAction('typing').catch(() => {});
  const interval = setInterval(() => ctx.sendChatAction('typing').catch(() => {}), 4000);
  return () => clearInterval(interval);
}

async function urlToGenerativePart(url, mimeType) {
  const response = await axios.get(url, { responseType: 'arraybuffer' });
  return {
    inlineData: { data: Buffer.from(response.data).toString('base64'), mimeType }
  };
}

// 🔄 SMART RETRY + FALLBACK (barcha modellarni sinab ko'radi)
async function generateWithRetry(modelsList, contents) {
  let lastError;

  for (const modelName of modelsList) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const model = genAI.getGenerativeModel({ model: modelName });
        const result = await model.generateContent(contents);
        return { result, usedModel: modelName };
      } catch (err) {
        lastError = err;
        const isRetryable = err.message && (
          err.message.includes('503') ||
          err.message.includes('Service Unavailable') ||
          err.message.includes('overloaded') ||
          err.message.includes('high demand') ||
          err.message.includes('429') ||
          err.message.includes('rate limit') ||
          err.message.includes('quota') ||
          err.message.includes('404')
        );

        if (isRetryable && attempt < 2) {
          await new Promise(r => setTimeout(r, 1200));
          continue;
        }
        break; // keyingi modelga o'tish
      }
    }
  }

  throw lastError;
}

// 🧠 Model tanlash
async function resolveModel(userId) {
  const isVIP = VIP_USERS.includes(userId);
  const limit = isVIP ? DAILY_LIMIT_VIP : DAILY_LIMIT_FREE;
  const usage = await getTodayUsage(userId);

  if (usage < limit) {
    return { models: PRO_MODELS, isVIP, usedPro: true, usage, limit };
  }
  return { models: FLASH_MODELS, isVIP, usedPro: false, usage, limit };
}

// 📝 Prompt qolip
function buildPrompt(userText, isImage = false) {
  return (
    `Sen BSB, CHSB va barcha fanlar bo'yicha aqlli AI yordamchisan.\n\n` +
    `QOIDALAR:\n` +
    `- Faqat o'zbek tilida yoz\n` +
    `- Qisqa va tushunarli yoz (maksimal 250-300 so'z)\n` +
    `- Har bir muhim qadamni emoji bilan boshla\n` +
    `- Oxirida 1 qatorlik xulosa ber\n\n` +
    (isImage ? `Rasmdagi masalani yech:\n${userText}` : `Savol: ${userText}`)
  );
}

// ═══════════════════════════════
//           BOT HANDLERLAR
// ═══════════════════════════════

bot.start((ctx) => {
  ctx.reply(
    '👋 Assalomu alaykum! Botga xush kelibsiz.\n\n📚 BSB, CHSB va istalgan fandan yordam beraman!\n\nQuyidagi bo\'limlardan birini tanlang:',
    Markup.inlineKeyboard([
      [Markup.button.callback('ℹ️ Bot haqida', 'about_bot')],
      [Markup.button.callback('💎 VIP obuna', 'donate_vip')],
      [Markup.button.callback('🆔 Mening ID raqamim', 'get_id')],
      [Markup.button.callback('📜 Mening tarixim', 'view_history')],
      [Markup.button.callback('👨‍💻 Admin bilan bog\'lanish', 'contact_admin')],
      [Markup.button.callback('🚀 Savol berish', 'start_asking')]
    ])
  );
});

bot.action('about_bot', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
    'ℹ️ Bot nima uchun?\n\n' +
    '📌 BSB, CHSB va istalgan fan bo\'yicha murakkab masalalar\n' +
    '📌 Rasmli masalalarni ham yechamiz\n' +
    '📌 O\'zbek tilida aniq va tez javob'
  );
});

bot.action('donate_vip', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
    `💎 VIP obuna imtiyozlari:\n\n` +
    `⚡ Kutish vaqti: atigi ${COOLDOWN_VIP} soniya (oddiylarda ${COOLDOWN_FREE}s)\n` +
    `🧠 Kuniga ${DAILY_LIMIT_VIP} marta kuchli Pro AI modeli\n` +
    `👑 VIP nishon va ustuvor xizmat\n\n` +
    `💳 VIP olish uchun: @XAVIK_ORG`
  );
});

bot.action('get_id', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(`🆔 Sizning Telegram ID:\n\n${ctx.from.id}\n\n(Nusxalash uchun ustiga bosing 📋)`);
});

bot.action('contact_admin', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('👨‍💻 Admin: @XAVIK_ORG');
});

bot.action('start_asking', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('🚀 Bot tayyor!\n\nSavol yozing yoki masala rasmini yuboring 👇');
});

bot.action('view_history', async (ctx) => {
  await ctx.answerCbQuery();
  try {
    const history = await getHistory(ctx.from.id, 5);

    if (!history.length) {
      return ctx.reply('📭 Hali savol tarixi yo\'q. Birinchi savolingizni yuboring!');
    }

    let text = '📜 Oxirgi savollaringiz:\n\n';
    history.forEach((item, i) => {
      const date = new Date(item.created_at).toLocaleString('uz-UZ');
      const shortQ = item.question.length > 80 ? item.question.substring(0, 80) + '...' : item.question;
      const shortA = item.answer.length > 150 ? item.answer.substring(0, 150) + '...' : item.answer;
      text += `${i + 1}. ${date}\n❓ ${shortQ}\n💡 ${shortA}\n\n`;
    });

    if (text.length > 4000) text = text.substring(0, 4000) + '\n\n...(qisqartirildi)';
    await ctx.reply(text);
  } catch (error) {
    console.error(error);
    await ctx.reply('❌ Tarixni olishda xatolik.');
  }
});

// 👑 ADMIN: VIP berish
// Format: /tabrik 123456789 Ism
bot.command('tabrik', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;

  const parts = ctx.message.text.split(' ');
  if (parts.length < 2) {
    return ctx.reply('⚠️ Format: /tabrik 123456789 Ism\n\nMasalan: /tabrik 123456789 Abdulloh');
  }

  const targetUserId = Number(parts[1]);
  const targetName = parts[2] || 'Aziz foydalanuvchi';

  if (!VIP_USERS.includes(targetUserId)) {
    VIP_USERS.push(targetUserId);
  }

  const tabrikText =
    `🎉 Tabriklaymiz, ${targetName}!\n\n` +
    `💎 VIP obuna muvaffaqiyatli ulandi!\n\n` +
    `✅ VIP imtiyozlaringiz:\n` +
    `👑 Eng kuchli Pro AI modeli\n` +
    `⚡ Atigi ${COOLDOWN_VIP} soniya kutish\n` +
    `🧠 Kuniga ${DAILY_LIMIT_VIP} marta Pro AI\n\n` +
    `🚀 Istalgan savol yoki masalangizni yuboring!`;

  try {
    // Botda (admin chatida) ko'rsatish
    await ctx.reply(tabrikText);
    // Foydalanuvchi lichkasiga ham yuborish
    await ctx.telegram.sendMessage(targetUserId, tabrikText).catch(() => {});
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
      `⏳ Biroz kuting!\n\nYana ${cooldown.remaining} soniya...` +
      (!cooldown.isVIP ? '\n\n💎 VIP da atigi 3 soniya kutiladi!' : '')
    );
  }

  const stopTyping = startTypingLoop(ctx);

  try {
    const { models, isVIP, usedPro, usage, limit } = await resolveModel(ctx.from.id);
    const prompt = buildPrompt(text);

    const { result, usedModel } = await generateWithRetry(models, prompt);
    const answer = await result.response.text();

    stopTyping();

    if (usedPro) await incrementUsage(ctx.from.id);

    const badge = usedPro
      ? (isVIP ? `👑 VIP Pro [${usage + 1}/${limit}]` : `🧠 Pro [${usage + 1}/${limit}]`)
      : `⚡ Tezkor [limit tugadi]`;

    const replyText = `${badge}\n\n${answer}`;

    if (replyText.length > 4000) {
      await ctx.reply(replyText.substring(0, 4000) + '\n\n...javob qisqartirildi');
    } else {
      await ctx.reply(replyText);
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
      `⏳ Biroz kuting!\n\nYana ${cooldown.remaining} soniya...` +
      (!cooldown.isVIP ? '\n\n💎 VIP da atigi 3 soniya kutiladi!' : '')
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

    stopTyping();

    if (usedPro) await incrementUsage(ctx.from.id);

    const badge = usedPro
      ? (isVIP ? `👑 VIP Pro [${usage + 1}/${limit}]` : `🧠 Pro [${usage + 1}/${limit}]`)
      : `⚡ Tezkor [limit tugadi]`;

    const replyText = `${badge}\n\n${answer}`;

    if (replyText.length > 4000) {
      await ctx.reply(replyText.substring(0, 4000) + '\n\n...javob qisqartirildi');
    } else {
      await ctx.reply(replyText);
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

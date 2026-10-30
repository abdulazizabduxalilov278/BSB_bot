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
const VIP_USERS = [609227381,];

// 👨‍💻 ADMIN ID RAQAMI (Buni faqat siz ishlata olishingiz uchun o'z ID raqamingizni yozing)
const ADMIN_ID = 8067736506;

// 📊 KUNLIK GEMINI PRO LIMITLARI
const DAILY_LIMIT_FREE = 10;
const DAILY_LIMIT_VIP = 40;

// ⏱️ COOLDOWN SOZLAMALARI (soniyalarda)
const COOLDOWN_FREE = 10; // Oddiy foydalanuvchilar uchun 10 sekund
const COOLDOWN_VIP = 3;   // VIP foydalanuvchilar uchun 3 sekund

const PRO_MODEL = 'gemini-3.1-pro-preview';
const FLASH_MODEL = 'gemini-3.7-flash';
const FLASH_FALLBACK_MODEL = 'gemini-1.5-flash'; // 503 xatoligida zaxira model

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
      if (now - time > 60000) {
        userLastMessageTime.delete(uid);
      }
    }
  }

  return { limited: false, isVIP };
}

// 🔁 TAKRORIY XABARLARNING OLDINI OLISH (Telegram webhook retry himoyasi)
// Agar javob uzoq kutilsa, Telegram xuddi shu xabarni qayta yuboradi.
// Shu sababli oldin ishlangan update_id larni saqlab, takrorlanganini e'tiborsiz qoldiramiz.
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
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

// 📈 Foydalanuvchining bugungi Gemini Pro ishlatish sonini olish
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

// ➕ Foydalanishni +1 oshirish (upsert)
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

// ⌨️ Javob tayyor bo'lguncha "yozyapti..." statusini uzluksiz ko'rsatish
// Telegram'da bu status atigi ~5 soniya ko'rinadi, shu uchun davriy yangilab turamiz
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

// 🔄 RETRY + FALLBACK: 503 yoki boshqa vaqtinchalik xatolikda qayta urinish
// Agar asosiy model (Flash) band bo'lsa, zaxira modelga (gemini-1.5-flash) o'tadi
async function generateWithRetry(modelName, contents, maxRetries = 2) {
  const modelsToTry = [modelName];

  // Flash modelida xatolik bo'lsa, zaxira modelni ham sinab ko'ramiz
  if (modelName === FLASH_MODEL && FLASH_MODEL !== FLASH_FALLBACK_MODEL) {
    modelsToTry.push(FLASH_FALLBACK_MODEL);
  }
  // Pro modelida xatolik bo'lsa ham flash_fallback sinab ko'ramiz
  if (modelName === PRO_MODEL) {
    modelsToTry.push(FLASH_MODEL);
    modelsToTry.push(FLASH_FALLBACK_MODEL);
  }

  let lastError;

  for (const tryModelName of modelsToTry) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const model = genAI.getGenerativeModel({ model: tryModelName });
        const result = await model.generateContent(contents);
        return { result, usedModel: tryModelName };
      } catch (err) {
        lastError = err;
        const is503 = err.message && (err.message.includes('503') || err.message.includes('Service Unavailable') || err.message.includes('overloaded') || err.message.includes('high demand'));
        const is429 = err.message && (err.message.includes('429') || err.message.includes('quota') || err.message.includes('rate limit'));

        if ((is503 || is429) && attempt < maxRetries) {
          // Bir oz kutib qayta urinish (1 sekund)
          await new Promise(r => setTimeout(r, 1000 * attempt));
          continue;
        }

        // 503/429 bo'lmasa yoki retry tugasa — keyingi modelga o'tish
        if (is503 || is429) break;

        // Boshqa xatolik bo'lsa — darhol throw
        throw err;
      }
    }
  }

  throw lastError;
}

// 🧠 Qaysi modelni ishlatish va limitni belgilash
async function resolveModel(userId) {
  const isVIP = VIP_USERS.includes(userId);
  const limit = isVIP ? DAILY_LIMIT_VIP : DAILY_LIMIT_FREE;
  const usage = await getTodayUsage(userId);

  if (usage < limit) {
    return { modelName: PRO_MODEL, isVIP, usedPro: true, usage, limit };
  }
  // Limit tugagan bo'lsa — tezkor (Flash) modelga avtomatik o'tish
  return { modelName: FLASH_MODEL, isVIP, usedPro: false, usage, limit };
}

bot.start((ctx) => {
  ctx.reply(
    '👋 Assalomu alaykum! Botga xush kelibsiz.\n\nBotdan foydalanishni boshlash uchun quyidagi bo\'limlardan birini tanlang:',
    Markup.inlineKeyboard([
      [Markup.button.callback('ℹ️ Bot nima uchun kerak?', 'about_bot')],
      [Markup.button.callback('💎 Donat (VIP) va uning foydasi', 'donate_vip')],
      [Markup.button.callback('🆔 Mening ID raqamimni bilish', 'get_id')],
      [Markup.button.callback('📜 Mening tarixim', 'view_history')],
      [Markup.button.callback('👨‍💻 Admin bilan bog\'lanish', 'contact_admin')],
      [Markup.button.callback('🚀 Botni boshlash (Savol berish)', 'start_asking')]
    ])
  );
});

bot.action('about_bot', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('ℹ️ **Bot nima uchun kerak?**\n\nBu bot BSB, CHSB va istalgan fandan berilgan murakkab vazifalarni yechishda yordam beradi.');
});

bot.action('donate_vip', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(`💎 **Donat (VIP) obunasi:**\n\n• 🚀 Tezkor va Navbatsiz javob (kutish vaqti atigi ${COOLDOWN_VIP} sekund, oddiy foydalanuvchilarda ${COOLDOWN_FREE} sekund).\n• 🧠 Super AI (Pro Model): kuniga ${DAILY_LIMIT_VIP} martagacha ishlatish.\n• 🆓 Oddiy foydalanuvchilar kuniga faqat ${DAILY_LIMIT_FREE} marta Pro modeldan foydalana oladi.\n\n💳 VIP xarid qilish uchun adminga yozing.`);
});

bot.action('get_id', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  await ctx.reply(`Sizning Telegram ID raqamingiz:\n\n\`${userId}\`\n\n*(Raqam ustiga bir marta bossangiz, avtomatik nusxalanadi) 📋*`, { parse_mode: 'Markdown' });
});

bot.action('contact_admin', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('👨‍💻 **Admin bilan bog\'lanish:** 👉 @XAVIK_ORG');
});

bot.action('start_asking', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('🚀 **Bot ishga tayyor!**\n\nMarhamat, savolni yozing yoki masalaning rasmini yuboring.');
});

// 📜 TARIXNI KO'RSATISH
bot.action('view_history', async (ctx) => {
  await ctx.answerCbQuery();
  try {
    const history = await getHistory(ctx.from.id, 5);

    if (!history.length) {
      return ctx.reply('📭 Sizda hali hech qanday savol tarixi yo\'q. Birinchi savolingizni yuboring!');
    }

    let text = '📜 **Oxirgi savollaringiz:**\n\n';
    history.forEach((item, i) => {
      const date = new Date(item.created_at).toLocaleString('uz-UZ');
      const shortQ = item.question.length > 100 ? item.question.substring(0, 100) + '...' : item.question;
      const shortA = item.answer.length > 200 ? item.answer.substring(0, 200) + '...' : item.answer;
      text += `**${i + 1}. ${date}**\n❓ ${shortQ}\n💡 ${shortA}\n\n`;
    });

    if (text.length > 4000) text = text.substring(0, 4000) + '\n\n...(qisqartirildi)';
    await ctx.reply(text, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error(error);
    await ctx.reply('❌ Tarixni olishda xatolik yuz berdi.');
  }
});

// 👑 MAXSUS ADMIN BUYRUG'I: VIP Tabrik yuborish
bot.command('tabrik', async (ctx) => {
  // Faqat admin ishlata olishini ta'minlash
  if (ctx.from.id !== ADMIN_ID) return;

  const parts = ctx.message.text.split(' ');

  if (parts.length < 2) {
    return ctx.reply('⚠️ Iltimos, mijozning ID raqamini kiriting. \nMasalan: `/tabrik 123456789`', { parse_mode: 'Markdown' });
  }

  const targetUserId = parts[1];

  try {
    // Mijozga tabrik yuborish
    await ctx.telegram.sendMessage(
      targetUserId,
      `🎉 **Tabriklaymiz!**\n\n💎 Sizga **VIP obuna** muvaffaqiyatli ulandi!\n\n🚀 Endi siz eng kuchli sun'iy intellekt (Pro Model) dan kuniga ${DAILY_LIMIT_VIP} martagacha foydalanishingiz mumkin.\n⏱️ Cooldown (kutish vaqti) esa atigi ${COOLDOWN_VIP} sekund!\n\nMarhamat, istalgan murakkab savol yoki masalangizni yuboring! Barchasini ajoyib qilib yechib beraman!`,
      { parse_mode: 'Markdown' }
    );
    // Adminga hisobot berish
    await ctx.reply(`✅ Tabrik xabari ${targetUserId} ID egasiga muvaffaqiyatli yuborildi!`);
  } catch (error) {
    await ctx.reply(`❌ Xatolik! Bunday ID topilmadi yoki foydalanuvchi botni bloklagan: ${error.message}`);
  }
});

// Matnli savollar
bot.on(message('text'), async (ctx) => {
  const text = ctx.message.text;
  if (text.startsWith('/')) return; // Komandalarni e'tiborsiz qoldirish

  const cooldown = checkCooldown(ctx.from.id);
  if (cooldown.limited) {
    return ctx.reply(
      `⏳ **Iltimos, biroz kuting!**\n\nKeyingi savolingizni yuborish uchun yana **${cooldown.remaining}** soniya kuting.${!cooldown.isVIP ? '\n\n💎 *VIP obunachilar uchun kutish vaqti atigi 3 sekund!*' : ''}`,
      { parse_mode: 'Markdown' }
    );
  }

  const stopTyping = startTypingLoop(ctx);

  try {
    const { modelName, isVIP, usedPro, usage, limit } = await resolveModel(ctx.from.id);

    const prompt = `Sen har qanday fan bo'yicha tajribali o'qituvchisan. Savolga o'zbek tilida qadam-baqadam to'liq yechim ber:\n\n${text}`;
    const { result, usedModel } = await generateWithRetry(modelName, prompt);
    const answer = await result.response.text();

    let replyText = '';
    if (usedPro) {
      const modelLabel = usedModel === PRO_MODEL
        ? (isVIP ? '👑 **VIP Yechim (Pro Model)' : '🧠 **Pro Model')
        : '⚡ **Tezkor Model (zaxira)';
      replyText = modelLabel + ` [${usage + 1}/${limit} bugungi limit]:**\n\n` + answer;
      await incrementUsage(ctx.from.id);
    } else {
      replyText = `⚡ **Tezkor Model** [kunlik Pro limitingiz tugadi]:\n\n` + answer;
    }

    stopTyping();

    if (replyText.length > 4000) {
      await ctx.reply(replyText.substring(0, 4000) + '\n\n...(Javob qisqartirildi)');
    } else {
      await ctx.reply(replyText);
    }

    saveHistory(ctx.from.id, text, answer).catch(() => {});
  } catch (error) {
    stopTyping();
    console.error(error);
    await ctx.reply(`❌ Xatolik yuz berdi: ${error.message}`);
  }
});

// Rasmli savollar
bot.on(message('photo'), async (ctx) => {
  const cooldown = checkCooldown(ctx.from.id);
  if (cooldown.limited) {
    return ctx.reply(
      `⏳ **Iltimos, biroz kuting!**\n\nKeyingi savolingizni yuborish uchun yana **${cooldown.remaining}** soniya kuting.${!cooldown.isVIP ? '\n\n💎 *VIP obunachilar uchun kutish vaqti atigi 3 sekund!*' : ''}`,
      { parse_mode: 'Markdown' }
    );
  }

  const stopTyping = startTypingLoop(ctx);

  try {
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const fileLink = await ctx.telegram.getFileLink(photo.file_id);
    const imagePart = await urlToGenerativePart(fileLink.href, 'image/jpeg');

    const { modelName, isVIP, usedPro, usage, limit } = await resolveModel(ctx.from.id);

    const userCaption = ctx.message.caption || 'Rasmdagi masalani qadam-baqadam yechib ber.';
    const prompt = `Sen tajribali o'qituvchisan. Ushbu rasmdagi vazifani o'zbek tilida qadam-baqadam yechib ber.\nIzoh: ${userCaption}`;

    const { result, usedModel } = await generateWithRetry(modelName, [prompt, imagePart]);
    const answer = await result.response.text();

    let replyText = '';
    if (usedPro) {
      const modelLabel = usedModel === PRO_MODEL
        ? (isVIP ? '👑 **VIP Yechim (Pro Model)' : '🧠 **Pro Model')
        : '⚡ **Tezkor Model (zaxira)';
      replyText = modelLabel + ` [${usage + 1}/${limit} bugungi limit]:**\n\n` + answer;
      await incrementUsage(ctx.from.id);
    } else {
      replyText = `⚡ **Tezkor Model** [kunlik Pro limitingiz tugadi]:\n\n` + answer;
    }

    stopTyping();

    if (replyText.length > 4000) {
      await ctx.reply(replyText.substring(0, 4000) + '\n\n...(Javob qisqartirildi)');
    } else {
      await ctx.reply(replyText);
    }

    saveHistory(ctx.from.id, `[Rasm] ${userCaption}`, answer).catch(() => {});
  } catch (error) {
    stopTyping();
    console.error(error);
    await ctx.reply(`❌ Rasmni o'qishda xatolik yuz berdi: ${error.message}`);
  }
});

module.exports = async (req, res) => {
  try {
    if (req.method === 'POST') {
      const update = req.body;

      // Takroriy (retry qilingan) update bo'lsa — darhol 200 qaytarib, qayta ishlamaymiz
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

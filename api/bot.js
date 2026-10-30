const { Telegraf, Markup } = require('telegraf');
const { message } = require('telegraf/filters');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');

// Fallback tokenlar (agar Vercel env variable larda uzilish bo'lsa ham bot to'xtamasligi uchun)
const BOT_TOKEN = process.env.BOT_TOKEN || '8847999795:AAFbQR81Q1_GpKPe9eRHG1wThJvkV3r5Vnc';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'AIzaSyAb8RN6JQksnA82sMy4-ZRzCHkdf2urD4dNCPUc4Adz87vVkd8g';

const bot = new Telegraf(BOT_TOKEN);
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// Supabase xavfsiz initsializatsiyasi (agar env bo'lmasa yoki xato bersa ham bot crash bo'lmaydi)
let supabase = null;
try {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_KEY) {
    const { createClient } = require('@supabase/supabase-js');
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  }
} catch (sbErr) {
  console.error('Supabase init xatosi:', sbErr.message);
  supabase = null;
}

// 👑 VIP FOYDALANUVCHILAR RO'YXATI
const VIP_USERS = [609227381];

// 👨‍💻 ADMIN ID
const ADMIN_ID = 8067736506;

// 📊 KUNLIK LIMITLAR
const DAILY_LIMIT_FREE = 10;
const DAILY_LIMIT_VIP = 40;

// ⏱️ COOLDOWN (soniyada)
const COOLDOWN_FREE = 10; // Oddiy foydalanuvchilar: 10 sekund
const COOLDOWN_VIP = 3;   // VIP foydalanuvchilar: 3 sekund

// 🤖 RASMIY BARQAROR MODELLAR
const MODEL_PRO = 'gemini-1.5-pro';
const MODEL_FLASH = 'gemini-1.5-flash';

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
    const first = processedUpdates.values().next().value;
    processedUpdates.delete(first);
  }
  return false;
}

function todayString() {
  return new Date().toISOString().slice(0, 10);
}

// 📈 Xavfsiz getTodayUsage
async function getTodayUsage(userId) {
  if (!supabase) return 0;
  try {
    const { data, error } = await supabase
      .from('usage_limits')
      .select('pro_count')
      .eq('user_id', userId)
      .eq('usage_date', todayString())
      .maybeSingle();

    if (error) return 0;
    return data ? data.pro_count : 0;
  } catch (e) {
    return 0;
  }
}

// ➕ Xavfsiz incrementUsage
async function incrementUsage(userId) {
  if (!supabase) return;
  try {
    const current = await getTodayUsage(userId);
    await supabase
      .from('usage_limits')
      .upsert(
        { user_id: userId, usage_date: todayString(), pro_count: current + 1 },
        { onConflict: 'user_id,usage_date' }
      );
  } catch (e) {}
}

// 💾 Xavfsiz saveHistory
async function saveHistory(userId, question, answer) {
  if (!supabase) return;
  try {
    await supabase
      .from('chat_history')
      .insert({ user_id: userId, question, answer: answer.substring(0, 2000) });
  } catch (e) {}
}

// 📜 Xavfsiz getHistory
async function getHistory(userId, limit = 5) {
  if (!supabase) return [];
  try {
    const { data, error } = await supabase
      .from('chat_history')
      .select('question, answer, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) return [];
    return data || [];
  } catch (e) {
    return [];
  }
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

// 🔄 AI GENERATSIYASI (Pro band bo'lsa darhol Flash ga o'tadi)
async function callGemini(contents, wantPro = false) {
  const modelsToTry = wantPro ? [MODEL_PRO, MODEL_FLASH] : [MODEL_FLASH];
  let lastError;

  for (const modelName of modelsToTry) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(contents);
      
      let answerText = '';
      try {
        answerText = result.response.text();
      } catch (respErr) {
        answerText = '⚠️ Ushbu savolga xavfsizlik qoidalari tufayli to\'liq javob berib bo\'lmadi. Iltimos, darslik yoki fan bo\'yicha boshqa savol yuboring.';
      }

      return { text: answerText, usedModel: modelName };
    } catch (err) {
      lastError = err;
      console.error(`Model ${modelName} error:`, err.message);
      continue;
    }
  }

  throw lastError;
}

async function resolveModelChoice(userId) {
  const isVIP = VIP_USERS.includes(userId);
  const limit = isVIP ? DAILY_LIMIT_VIP : DAILY_LIMIT_FREE;
  const usage = await getTodayUsage(userId);
  const canUsePro = usage < limit;

  return { wantPro: canUsePro, isVIP, usage, limit };
}

function buildPrompt(userText, isImage = false) {
  return (
    `Sen har qanday fan bo'yicha tajribali o'qituvchisan.\n` +
    `QOIDALAR:\n` +
    `1. O'zbek tilida yoz.\n` +
    `2. Qisqa, aniq va tushunarli bo'lsin (maksimal 200-300 so'z).\n` +
    `3. Chiroyli o'qilishi uchun tegishli joylariga stiker/emojilar qo'sh (masalan: 💡, 📝, 📌, ✅, 🔢).\n` +
    `4. Muhim formulalar va xulosani alohida ajratib ko'rsat.\n\n` +
    (isImage ? `Rasmdagi masalani yech. Foydalanuvchi izohi: ${userText}` : `Savol: ${userText}`)
  );
}

// ═══════════════════════════════
//           BOT BUYRUQLARI
// ═══════════════════════════════

bot.start((ctx) => {
  ctx.reply(
    '👋 Assalomu alaykum! Botga xush kelibsiz.\n\n' +
    '📚 BSB, CHSB va barcha fanlardan murakkab masalalarni yechishda yordam beraman!\n\n' +
    'Quyidagi bo\'limlardan birini tanlang:',
    Markup.inlineKeyboard([
      [Markup.button.callback('ℹ️ Bot haqida', 'about_bot')],
      [Markup.button.callback('💎 VIP obuna', 'donate_vip')],
      [Markup.button.callback('🆔 Mening ID raqamim', 'get_id')],
      [Markup.button.callback('📜 Mening tarixim', 'view_history')],
      [Markup.button.callback('👨‍💻 Admin bilan bog\'lanish', 'contact_admin')],
      [Markup.button.callback('🚀 Savol berish', 'start_asking')]
    ])
  ).catch(console.error);
});

bot.action('about_bot', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await ctx.reply(
    'ℹ️ **Bot haqida:**\n\n' +
    '📌 BSB, CHSB va istalgan fan bo\'yicha vazifalarni tez va tushunarli qilib yechib beradi.\n' +
    '📷 Masalaning rasmini yuborsangiz ham o\'qib, to\'liq yechim beradi.\n' +
    '⚡ Eng so\'nggi AI modellari orqali ishlaydi.',
    { parse_mode: 'Markdown' }
  ).catch(console.error);
});

bot.action('donate_vip', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await ctx.reply(
    `💎 **VIP obuna imtiyozlari:**\n\n` +
    `⚡ **Tezkor javob:** Kutish vaqti (cooldown) atigi **${COOLDOWN_VIP} soniya** (oddiylar uchun ${COOLDOWN_FREE}s).\n` +
    `🧠 **Super AI:** Kuniga **${DAILY_LIMIT_VIP} marta** kuchli Pro modeldan foydalanish.\n` +
    `👑 **Ustuvorlik:** Server band bo'lganda ham navbatsiz xizmat.\n\n` +
    `💳 VIP obuna olish uchun adminga yozing: @XAVIK_ORG`,
    { parse_mode: 'Markdown' }
  ).catch(console.error);
});

bot.action('get_id', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await ctx.reply(
    `🆔 Sizning Telegram ID raqamingiz:\n\n\`${ctx.from.id}\`\n\n*(Nusxalash uchun raqam ustiga bosing)* 📋`,
    { parse_mode: 'Markdown' }
  ).catch(console.error);
});

bot.action('contact_admin', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await ctx.reply('👨‍💻 **Admin bilan bog\'lanish:** 👉 @XAVIK_ORG', { parse_mode: 'Markdown' }).catch(console.error);
});

bot.action('start_asking', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await ctx.reply('🚀 **Bot ishga tayyor!**\n\nMarhamat, savolingizni yozing yoki masala rasmini yuboring 👇', { parse_mode: 'Markdown' }).catch(console.error);
});

bot.action('view_history', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  try {
    const history = await getHistory(ctx.from.id, 5);

    if (!history.length) {
      return ctx.reply('📭 Sizda hali hech qanday savol tarixi yo\'q. Savolingizni yuboring!');
    }

    let text = '📜 **Oxirgi 5 ta savolingiz:**\n\n';
    history.forEach((item, i) => {
      const date = new Date(item.created_at).toLocaleString('uz-UZ');
      const shortQ = item.question.length > 70 ? item.question.substring(0, 70) + '...' : item.question;
      const shortA = item.answer.length > 130 ? item.answer.substring(0, 130) + '...' : item.answer;
      text += `**${i + 1}. ${date}**\n❓ ${shortQ}\n💡 ${shortA}\n\n`;
    });

    if (text.length > 4000) text = text.substring(0, 4000) + '\n\n...(qisqartirildi)';
    await ctx.reply(text, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error(error);
    await ctx.reply('❌ Tarixni olishda xatolik.');
  }
});

// 👑 ADMIN: VIP Tabrik
// Format: /tabrik 123456789 Ali
bot.command('tabrik', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;

  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 2) {
    return ctx.reply('⚠️ **Format:** `/tabrik <ID> <Ism>`\nMasalan: `/tabrik 123456789 Jasur`', { parse_mode: 'Markdown' });
  }

  const targetUserId = Number(parts[1]);
  const targetName = parts.slice(2).join(' ') || 'Foydalanuvchi';

  if (!VIP_USERS.includes(targetUserId)) {
    VIP_USERS.push(targetUserId);
  }

  const tabrikText =
    `🎉 **Tabriklaymiz, ${targetName}!**\n\n` +
    `💎 Sizga **VIP obuna** muvaffaqiyatli faollashtirildi!\n\n` +
    `✨ **Sizning afzalliklaringiz:**\n` +
    `⚡ Kutish vaqti (cooldown): atigi **${COOLDOWN_VIP} soniya**\n` +
    `🧠 Eng kuchli Pro AI modeli: kuniga **${DAILY_LIMIT_VIP} marta**\n` +
    `🚀 Tezkor va navbatsiz javoblar\n\n` +
    `Marhamat, savolingizni yoki masalangiz rasmini yuboring!`;

  await ctx.reply(tabrikText, { parse_mode: 'Markdown' });

  ctx.telegram.sendMessage(targetUserId, tabrikText, { parse_mode: 'Markdown' })
    .then(() => ctx.reply(`✅ Xabar shuningdek ${targetUserId} ga lichkaga ham yetkazildi.`))
    .catch(() => ctx.reply(`ℹ️ Lichkaga yuborilmadi (foydalanuvchi botni start qilmagan yoki bloklagan). Lekin VIP qo'shildi!`));
});

// 📝 MATNLI SAVOLLAR
bot.on(message('text'), async (ctx) => {
  const text = ctx.message.text;
  if (!text || text.startsWith('/')) return;

  const cooldown = checkCooldown(ctx.from.id);
  if (cooldown.limited) {
    return ctx.reply(
      `⏳ **Iltimos, biroz kuting!**\n\nKeyingi savol uchun yana **${cooldown.remaining}** soniya kuting.` +
      (!cooldown.isVIP ? `\n\n💎 *VIP foydalanuvchilar uchun kutish vaqti atigi ${COOLDOWN_VIP} sekund!*` : ''),
      { parse_mode: 'Markdown' }
    );
  }

  const stopTyping = startTypingLoop(ctx);

  try {
    const { wantPro, isVIP, usage, limit } = await resolveModelChoice(ctx.from.id);
    const prompt = buildPrompt(text, false);

    const { text: answer, usedModel } = await callGemini(prompt, wantPro);

    stopTyping();

    if (wantPro && usedModel === MODEL_PRO) {
      await incrementUsage(ctx.from.id);
    }

    const badge = (wantPro && usedModel === MODEL_PRO)
      ? (isVIP ? `👑 **VIP Yechim (Pro Model) [${usage + 1}/${limit}]:**` : `🧠 **Pro Model [${usage + 1}/${limit}]:**`)
      : `⚡ **Tezkor Yechim:**`;

    const fullReply = `${badge}\n\n${answer}`;

    if (fullReply.length > 4000) {
      await ctx.reply(fullReply.substring(0, 4000) + '\n\n...(qisqartirildi)');
    } else {
      await ctx.reply(fullReply);
    }

    saveHistory(ctx.from.id, text, answer).catch(() => {});
  } catch (error) {
    stopTyping();
    console.error('Matn handler xatosi:', error);
    await ctx.reply(`❌ Xatolik yuz berdi: ${error.message || 'Server javob bermadi'}\nIltimos, qaytadan yuborib ko'ring.`);
  }
});

// 🖼️ RASMLI SAVOLLAR
bot.on(message('photo'), async (ctx) => {
  const cooldown = checkCooldown(ctx.from.id);
  if (cooldown.limited) {
    return ctx.reply(
      `⏳ **Iltimos, biroz kuting!**\n\nKeyingi savol uchun yana **${cooldown.remaining}** soniya kuting.` +
      (!cooldown.isVIP ? `\n\n💎 *VIP foydalanuvchilar uchun kutish vaqti atigi ${COOLDOWN_VIP} sekund!*` : ''),
      { parse_mode: 'Markdown' }
    );
  }

  const stopTyping = startTypingLoop(ctx);

  try {
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const fileLink = await ctx.telegram.getFileLink(photo.file_id);
    const imagePart = await urlToGenerativePart(fileLink.href, 'image/jpeg');

    const { wantPro, isVIP, usage, limit } = await resolveModelChoice(ctx.from.id);
    const userCaption = ctx.message.caption || 'Rasmdagi masalani batafsil yechib ber.';
    const prompt = buildPrompt(userCaption, true);

    const { text: answer, usedModel } = await callGemini([prompt, imagePart], wantPro);

    stopTyping();

    if (wantPro && usedModel === MODEL_PRO) {
      await incrementUsage(ctx.from.id);
    }

    const badge = (wantPro && usedModel === MODEL_PRO)
      ? (isVIP ? `👑 **VIP Yechim (Pro Model) [${usage + 1}/${limit}]:**` : `🧠 **Pro Model [${usage + 1}/${limit}]:**`)
      : `⚡ **Tezkor Yechim:**`;

    const fullReply = `${badge}\n\n${answer}`;

    if (fullReply.length > 4000) {
      await ctx.reply(fullReply.substring(0, 4000) + '\n\n...(qisqartirildi)');
    } else {
      await ctx.reply(fullReply);
    }

    saveHistory(ctx.from.id, `[Rasm] ${userCaption}`, answer).catch(() => {});
  } catch (error) {
    stopTyping();
    console.error('Rasm handler xatosi:', error);
    await ctx.reply(`❌ Rasmni o'qishda xatolik yuz berdi: ${error.message || 'Server javob bermadi'}\nIltimos, qaytadan yuborib ko'ring.`);
  }
});

// Vercel Serverless Function Handler
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
    console.error('Serverless Handler xatosi:', e);
    res.status(200).json({ ok: true, error: e.message });
  }
};

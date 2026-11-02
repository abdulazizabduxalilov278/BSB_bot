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

// 🤖 AVTO-YANGILANIB TURADIGAN MODELLAR TIZIMI
// Banned (eskirgan / 404 bergan) modellar
const bannedModels = new Set();

// 2026-yilgi eng so'nggi va tavsiya etilgan modellar (zaxira va boshlang'ich kesh)
let cachedFlashModels = [
  'gemini-3.8-flash',
  'gemini-3.0-flash',
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-1.5-flash-latest',
  'gemini-1.5-flash-002',
  'gemini-1.5-flash'
];

let cachedProModels = [
  'gemini-3.8-pro',
  'gemini-3.0-pro',
  'gemini-2.5-pro',
  'gemini-2.0-pro',
  'gemini-1.5-pro-latest',
  'gemini-1.5-pro-002',
  'gemini-1.5-pro'
];

let lastModelsFetchTime = 0;
const MODELS_CACHE_TTL = 1000 * 60 * 60 * 2; // 2 soat kesh
let isFetchingModels = false;

function extractModelVersion(name) {
  const m = name.match(/gemini-(\d+(?:\.\d+)?)/i);
  return m ? parseFloat(m[1]) : 0;
}

function sortModelsDescending(models) {
  return [...new Set(models)].sort((a, b) => {
    const vDiff = extractModelVersion(b) - extractModelVersion(a);
    if (vDiff !== 0) return vDiff;
    return a.localeCompare(b);
  });
}

// Google API orqali mavjud barcha modellarni avtomatik aniqlash
async function updateModelsFromGoogleAPI(force = false) {
  const now = Date.now();
  if (!force && (now - lastModelsFetchTime < MODELS_CACHE_TTL)) {
    return;
  }
  if (isFetchingModels) return;
  isFetchingModels = true;

  try {
    const response = await axios.get(
      'https://generativelanguage.googleapis.com/v1beta/models',
      {
        params: { key: GEMINI_API_KEY },
        timeout: 5000
      }
    );

    const rawModels = response.data && Array.isArray(response.data.models)
      ? response.data.models
      : [];

    const available = rawModels
      .filter((m) =>
        m &&
        typeof m.name === 'string' &&
        Array.isArray(m.supportedGenerationMethods) &&
        m.supportedGenerationMethods.includes('generateContent')
      )
      .map((m) => m.name.replace(/^models\//, ''))
      .filter((name) => !bannedModels.has(name));

    const flash = available.filter((name) => name.toLowerCase().includes('flash'));
    const pro = available.filter((name) => name.toLowerCase().includes('pro'));

    if (flash.length > 0) {
      cachedFlashModels = sortModelsDescending([...flash, ...cachedFlashModels.filter((m) => !bannedModels.has(m))]);
    }
    if (pro.length > 0) {
      cachedProModels = sortModelsDescending([...pro, ...cachedProModels.filter((m) => !bannedModels.has(m))]);
    }

    lastModelsFetchTime = now;
    console.log('✅ Gemini modellar ro\'yxati Google API orqali yangilandi:', {
      topFlash: cachedFlashModels[0],
      topPro: cachedProModels[0]
    });
  } catch (err) {
    console.warn('⚠️ Gemini modellarini Google API dan olishda ogohlantirish (keshdagi modellar ishlatiladi):', err.message);
  } finally {
    isFetchingModels = false;
  }
}

async function getModelsToTry(wantPro = false) {
  const now = Date.now();
  if (now - lastModelsFetchTime > MODELS_CACHE_TTL) {
    if (cachedFlashModels.length === 0) {
      await updateModelsFromGoogleAPI();
    } else {
      updateModelsFromGoogleAPI().catch(() => {});
    }
  }

  const activeFlash = cachedFlashModels.filter((m) => !bannedModels.has(m));
  const activePro = cachedProModels.filter((m) => !bannedModels.has(m));

  const flashList = activeFlash.length > 0 ? activeFlash : ['gemini-3.8-flash', 'gemini-2.5-flash'];
  const proList = activePro.length > 0 ? activePro : ['gemini-3.8-pro', 'gemini-2.5-pro'];

  if (wantPro) {
    return [...new Set([...proList, ...flashList])];
  }
  return flashList;
}

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

// 🔄 AVTO-TIKLANUVCHI VA DOIM YANGI AI GENERATSIYASI (404/503 bo'lsa darhol yangi modelga o'tadi)
async function callGemini(contents, wantPro = false) {
  let modelsToTry = await getModelsToTry(wantPro);
  let lastError;
  let retriedAfterRefresh = false;

  for (let i = 0; i < modelsToTry.length; i++) {
    const modelName = modelsToTry[i];
    if (bannedModels.has(modelName)) continue;

    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(contents);

      let answerText = '';
      try {
        answerText = result.response.text();
      } catch (respErr) {
        answerText = '⚠️ Ushbu savolga xavfsizlik qoidalari tufayli to\'liq javob berib bo\'lmadi. Iltimos, darslik yoki fan bo\'yicha boshqa savol yuboring.';
      }

      // Muvaffaqiyatli modelni kesh boshiga surish (keyingi safar 0ms kechikish bilan shu model ishlatiladi)
      if (modelName.toLowerCase().includes('pro')) {
        cachedProModels = [modelName, ...cachedProModels.filter((m) => m !== modelName)];
      } else {
        cachedFlashModels = [modelName, ...cachedFlashModels.filter((m) => m !== modelName)];
      }

      return { text: answerText, usedModel: modelName };
    } catch (err) {
      lastError = err;
      const errMsg = err?.message || '';
      console.error(`Model [${modelName}] xatosi:`, errMsg);

      // Agar model eskirgan yoki topilmagan bo'lsa (404 Not Found)
      const is404 = errMsg.includes('404') || errMsg.includes('not found') || errMsg.includes('no longer available');
      if (is404) {
        bannedModels.add(modelName);
        console.warn(`⚠️ Model [${modelName}] ro'yxatdan o'chirildi (banned).`);

        // Google o'z xatolik xabarida yangi modelni tavsiya qilgan bo'lsa
        // Masalan: "Please update your code to use models/gemini-3.8-flash"
        const suggestedMatch = errMsg.match(/use (?:models\/)?(gemini-[a-zA-Z0-9_.-]+)/i);
        if (suggestedMatch && suggestedMatch[1]) {
          const suggestedModel = suggestedMatch[1];
          if (!bannedModels.has(suggestedModel) && !modelsToTry.includes(suggestedModel)) {
            console.log(`💡 Google tomonidan tavsiya qilingan yangi model qo'shildi: ${suggestedModel}`);
            modelsToTry.splice(i + 1, 0, suggestedModel);
            if (suggestedModel.toLowerCase().includes('pro')) {
              cachedProModels.unshift(suggestedModel);
            } else {
              cachedFlashModels.unshift(suggestedModel);
            }
          }
        }
      }

      // Agar barcha modellar 404 bersa va hali API dan majburiy yangilanmagan bo'lsa
      if (i === modelsToTry.length - 1 && !retriedAfterRefresh && is404) {
        console.log('🔄 Barcha mavjud modellar 404 berdi. Google API dan yangi modellar olinmoqda...');
        retriedAfterRefresh = true;
        await updateModelsFromGoogleAPI(true);
        modelsToTry = await getModelsToTry(wantPro);
        i = -1; // Qaytadan yangi modellar bilan boshlash
      }
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

bot.action(['about_bot', 'help'], async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await ctx.reply(
    'ℹ️ **Bot haqida:**\n\n' +
    '📌 BSB, CHSB va istalgan fan bo\'yicha vazifalarni tez va tushunarli qilib yechib beradi.\n' +
    '📷 Masalaning rasmini yuborsangiz ham o\'qib, to\'liq yechim beradi.\n' +
    '⚡ Eng so\'nggi AI modellari orqali ishlaydi.',
    { parse_mode: 'Markdown' }
  ).catch(console.error);
});

bot.action(['donate_vip', 'vip_info'], async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await ctx.reply(
    `💎 **VIP obuna va uning imtiyozlari:**\n\n` +
    `💰 **Obuna narxi:** 1 oyga **10 000 so'm**\n\n` +
    `✨ **Sizga beriladigan imtiyozlar:**\n` +
    `⏳ **To'xtovsiz savollar:** Savollar orasidagi kutish vaqti atigi **${COOLDOWN_VIP} soniya** (oddiy foydalanuvchilarda ${COOLDOWN_FREE}s).\n` +
    `🧠 **Super AI (Pro Model):** Kuniga **${DAILY_LIMIT_VIP} marta** eng kuchli Pro AI modelidan foydalanish.\n` +
    `👑 **Ustuvorlik:** Server band bo'lganda ham navbatsiz xizmat.\n\n` +
    `💳 **VIP xarid qilish uchun adminga yozing:** 👇`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.url('💳 Obuna sotib olish (@XAVIK_ORG)', 'https://t.me/XAVIK_ORG')]
      ])
    }
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
    `⏳ Savollar orasidagi kutish vaqti: atigi **${COOLDOWN_VIP} soniya**\n` +
    `🧠 Eng kuchli Pro AI modeli: kuniga **${DAILY_LIMIT_VIP} marta**\n` +
    `🚀 Ustuvor va navbatsiz xizmat ko'rsatish\n\n` +
    `Marhamat, savolingizni yoki masalangiz rasmini yuboring!`;

  await ctx.reply(tabrikText, { parse_mode: 'Markdown' });

  ctx.telegram.sendMessage(targetUserId, tabrikText, { parse_mode: 'Markdown' })
    .then(() => ctx.reply(`✅ Xabar shuningdek ${targetUserId} ga lichkaga ham yetkazildi.`))
    .catch(() => ctx.reply(`ℹ️ Lichkaga yuborilmadi (foydalanuvchi botni start qilmagan yoki bloklagan). Lekin VIP qo'shildi!`));
});

// 👑 ADMIN: Modellarni ko'rish va yangilash
bot.command('models', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const activeFlash = cachedFlashModels.filter((m) => !bannedModels.has(m));
  const activePro = cachedProModels.filter((m) => !bannedModels.has(m));
  const banned = Array.from(bannedModels);

  const statusText =
    `🤖 **Gemini Modellari Holati:**\n\n` +
    `⚡ **Faol Flash modellar:**\n${activeFlash.map((m) => `✅ \`${m}\``).join('\n') || 'Hech biri faol emas'}\n\n` +
    `🧠 **Faol Pro modellar:**\n${activePro.map((m) => `✅ \`${m}\``).join('\n') || 'Hech biri faol emas'}\n\n` +
    (banned.length > 0 ? `🚫 **Eskirgan (Banned 404):**\n${banned.map((m) => `❌ ~~${m}~~`).join('\n')}\n\n` : '') +
    `⏱️ **Oxirgi yangilanish:** ${lastModelsFetchTime ? new Date(lastModelsFetchTime).toLocaleTimeString('uz-UZ') : 'Boshlang\'ich kesh'}\n\n` +
    `🔄 Google API dan darhol yangilash uchun: /refresh_models`;

  await ctx.reply(statusText, { parse_mode: 'Markdown' });
});

bot.command('refresh_models', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  await ctx.reply('🔄 Google API orqali eng so\'nggi modellar ro\'yxati olinmoqda...');
  try {
    await updateModelsFromGoogleAPI(true);
    await ctx.reply('✅ Modellar ro\'yxati muvaffaqiyatli yangilandi!\nKo\'rish uchun: /models');
  } catch (e) {
    await ctx.reply(`❌ Yangilashda xatolik: ${e.message}`);
  }
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

    const isPro = wantPro && usedModel.includes('pro');
    if (isPro) {
      await incrementUsage(ctx.from.id);
    }

    const badge = isPro
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

    const isPro = wantPro && usedModel.includes('pro');
    if (isPro) {
      await incrementUsage(ctx.from.id);
    }

    const badge = isPro
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

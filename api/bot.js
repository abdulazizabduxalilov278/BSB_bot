const { Telegraf, Markup } = require('telegraf');
const { message } = require('telegraf/filters');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');

const bot = new Telegraf(process.env.BOT_TOKEN);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// 👑 VIP FOYDALANUVCHILAR RO'YXATI
// Shu yerga vergul bilan ID larni qo'shib borasiz
const VIP_USERS = [123456789, 987654321]; 

async function urlToGenerativePart(url, mimeType) {
  const response = await axios.get(url, { responseType: 'arraybuffer' });
  return {
    inlineData: {
      data: Buffer.from(response.data).toString('base64'),
      mimeType
    },
  };
}

bot.start((ctx) => {
  ctx.reply(
    '👋 Assalomu alaykum! Botga xush kelibsiz.\n\nBotdan foydalanishni boshlash uchun quyidagi bo\'limlardan birini tanlang:',
    Markup.inlineKeyboard([
      [Markup.button.callback('ℹ️ Bot nima uchun kerak?', 'about_bot')],
      [Markup.button.callback('💎 Donat (VIP) va uning foydasi', 'donate_vip')],
      [Markup.button.callback('🆔 Mening ID raqamimni bilish', 'get_id')],
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
  await ctx.reply('💎 **Donat (VIP) obunasi:**\n\n• 🚀 Tezkor va Navbatsiz javob.\n• 🧠 Super AI (Pro Model): Qiyin olimpiada savollariga ham 100% aniq javoblar.\n\n💳 VIP xarid qilish uchun adminga yozing.');
});

// YANGI BO'LIM: ID ni olish tugmasi bosilganda
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

// Matnli savollar
bot.on(message('text'), async (ctx) => {
  const text = ctx.message.text;
  if (text.startsWith('/')) return;

  try {
    await ctx.sendChatAction('typing');
    
    const isVIP = VIP_USERS.includes(ctx.from.id);
    const selectedModel = isVIP ? 'gemini-1.5-pro-002' : 'gemini-1.5-flash-002';
    const model = genAI.getGenerativeModel({ model: selectedModel });
    
    const prompt = `Sen har qanday fan bo'yicha tajribali o'qituvchisan. Savolga o'zbek tilida qadam-baqadam to'liq yechim ber:\n\n${text}`;
    const result = await model.generateContent(prompt);
    const answer = await result.response.text();
    
    let replyText = isVIP ? '👑 **VIP Yechim (Pro Model):**\n\n' + answer : answer;
    
    if (replyText.length > 4000) {
        await ctx.reply(replyText.substring(0, 4000) + '\n\n...(Javob qisqartirildi)');
    } else {
        await ctx.reply(replyText);
    }
  } catch (error) {
    console.error(error);
    await ctx.reply(`❌ Xatolik yuz berdi: ${error.message}`);
  }
});

// Rasmli savollar
bot.on(message('photo'), async (ctx) => {
  try {
    await ctx.sendChatAction('typing');
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const fileLink = await ctx.telegram.getFileLink(photo.file_id);
    const imagePart = await urlToGenerativePart(fileLink.href, 'image/jpeg');
    
    const isVIP = VIP_USERS.includes(ctx.from.id);
    const selectedModel = isVIP ? 'gemini-1.5-pro-002' : 'gemini-1.5-flash-002';
    const model = genAI.getGenerativeModel({ model: selectedModel });
    
    const userCaption = ctx.message.caption || 'Rasmdagi masalani qadam-baqadam yechib ber.';
    const prompt = `Sen tajribali o'qituvchisan. Ushbu rasmdagi vazifani o'zbek tilida qadam-baqadam yechib ber.\nIzoh: ${userCaption}`;

    const result = await model.generateContent([prompt, imagePart]);
    const answer = await result.response.text();
    
    let replyText = isVIP ? '👑 **VIP Yechim (Pro Model):**\n\n' + answer : answer;

    if (replyText.length > 4000) {
        await ctx.reply(replyText.substring(0, 4000) + '\n\n...(Javob qisqartirildi)');
    } else {
        await ctx.reply(replyText);
    }
  } catch (error) {
    console.error(error);
    await ctx.reply(`❌ Rasmni o\'qishda xatolik yuz berdi: ${error.message}`);
  }
});

module.exports = async (req, res) => {
  try {
    if (req.method === 'POST') {
      await bot.handleUpdate(req.body);
    }
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
};
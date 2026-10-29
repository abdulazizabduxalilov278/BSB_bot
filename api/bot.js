const { Telegraf, Markup } = require('telegraf');
const { message } = require('telegraf/filters');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');

const bot = new Telegraf(process.env.BOT_TOKEN);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// 👑 VIP FOYDALANUVCHILAR RO'YXATI
// Shu yerga vergul bilan mijozlarning ID larini qo'shib borasiz
const VIP_USERS = [123456789, 987654321]; 

// 👨‍💻 ADMIN ID RAQAMI (Buni faqat siz ishlata olishingiz uchun o'z ID raqamingizni yozing)
const ADMIN_ID = 123456789; 

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
      '🎉 **Tabriklaymiz!**\n\n💎 Sizga **VIP obuna** muvaffaqiyatli ulandi!\n\n🚀 Endi siz eng kuchli sun\'iy intellekt (Pro Model) dan cheklovlarsiz va eng yuqori tezlikda foydalanishingiz mumkin. \n\nMarhamat, istalgan murakkab savol yoki masalangizni yuboring! Barchasini ajoyib qilib yechib beraman!', 
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

  try {
    await ctx.sendChatAction('typing');
    
    const isVIP = VIP_USERS.includes(ctx.from.id);
    const selectedModel = isVIP ? 'gemini-3.1-pro-preview' : 'gemini-3.7-flash';
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
    const selectedModel = isVIP ? 'gemini-3.1-pro-preview' : 'gemini-3.7-flash';
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
const { Telegraf, Markup } = require('telegraf');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');

const bot = new Telegraf(process.env.BOT_TOKEN);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function urlToGenerativePart(url, mimeType) {
  const response = await axios.get(url, { responseType: 'arraybuffer' });
  return {
    inlineData: {
      data: Buffer.from(response.data).toString('base64'),
      mimeType
    },
  };
}

// /start komandasi bosilganda asosiy menyu va barcha tugmalarni chiqarish
bot.start((ctx) => {
  ctx.reply(
    '👋 Asosiy menyu:\n\n📚 BSB va CHSB vazifalarini yechish uchun rasm yuboring:',
    Markup.inlineKeyboard([
      [Markup.button.callback('📌 Qanday foydalanish kerak?', 'how_to_use')],
      [Markup.button.callback('💎 VIP Obuna sotib olish', 'vip_info')],
      [Markup.button.callback('👨‍💻 Dasturchi bilan bog\'lanish', 'contact_dev')],
      [Markup.button.callback('❓ Savol berish', 'ask_question')]
    ])
  );
});

// Qanday foydalanish kerak?
bot.action('how_to_use', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
    '📌 **Botdan qanday foydalaniladi?**\n\n' +
    '1. Istalgan fan (Matematika, Fizika, Kimyo, Tarix va h.k.) BSB yoki CHSB savollarining rasmini aniq qilib yuboring.\n' +
    '2. Yoki savolni matn ko\'rinishida yozib yuboring.\n' +
    '3. Bot bir necha soniya ichida sizga qadam-baqadam to\'liq yechimini chiqarib beradi!'
  );
});

// VIP Obuna sotib olish va farqlari
bot.action('vip_info', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
    '💎 **VIP Obuna haqida ma\'lumot va farqi:**\n\n' +
    '🔹 **Oddiy versiya:** Barcha savollarga umumiy navbatda javob oladi va kunlik so\'rovlar soni cheklangan bo\'lishi mumkin.\n' +
    '🔹 **VIP Obuna (Farqi):**\n' +
    '• 🚀 **Ustuvor navbat:** Savollaringizga birinchilardan bo\'lib, eng yuqori tezlikda javob beriladi.\n' +
    '• ♾️ **Cheklovsiz yechimlar:** Kun davomida istaganingizcha ko\'p BSB va CHSB rasmlarini tashlashingiz mumkin.\n' +
    '• 🧠 **Kuchaytirilgan sun\'iy intellekt:** Eng murakkab olimpiada va murakkab masalalarga ham 100% aniq va kengaytirilgan tushuntirishlar beriladi.\n\n' +
    '💳 VIP obunani ulash uchun dasturchiga yozing: @XAVIK_ORG'
  );
});

// Dasturchi bilan bog'lanish
bot.action('contact_dev', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('👨‍💻 Dasturchi bilan bog\'lanish uchun: @XAVIK_ORG ga yozishingiz mumkin.');
});

// Savol berish
bot.action('ask_question', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('Marhamat, o\'zingizni qiziqtirgan savolni yozib yuboring yoki masalaning rasmini tashlang. Men uni qadam-baqadam va oddiy tilda tushuntirib beraman!');
});

// Matnli xabarlar uchun
bot.on('text', async (ctx) => {
  const text = ctx.message.text;

  try {
    await ctx.sendChatAction('typing');
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    
    const prompt = `Sen har qanday fan bo'yicha (matematika, fizika, kimyo, ona tili, tarix va hokazo) tajribali va mehribon o'qituvchisan. Foydalanuvchi yuborgan quyidagi savol yoki masalaga o'zbek tilida oddiy odam tushunadigan qilib, ketma-ketlikda (qadam-baqadam) to'liq yechim ber:\n\n${text}`;
    
    const result = await model.generateContent(prompt);
    const response = await result.response;
    await ctx.reply(response.text());
  } catch (error) {
    console.error(error);
    ctx.reply('Kechirasiz, savolingizga javob topishda kichik xatolik yuz berdi. Iltimos, qaytadan yozib yuboring.');
  }
});

// Rasmli xabarlar uchun
bot.on('photo', async (ctx) => {
  try {
    await ctx.sendChatAction('typing');
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const fileLink = await ctx.telegram.getFileLink(photo.file_id);
    
    const imagePart = await urlToGenerativePart(fileLink.href, 'image/jpeg');
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    
    const userCaption = ctx.message.caption || 'Bu rasmdagi masalani yoki savolni qaysi fandan bo\'lishidan qat\'iy nazar oddiy va tushunarli qilib, qadam-baqadam yechib ber.';
    const prompt = `Sen tajribali o'qituvchisan. Ushbu rasmdagi vazifani yoki masalani diqqat bilan o'qib chiq va o'zbek tilida oddiy, tushunarli qilib, ketma-ketlikda (qadam-baqadam) yechimini yozib ber.\nFoydalanuvchi izohi: ${userCaption}`;

    const result = await model.generateContent([prompt, imagePart]);
    const response = await result.response;
    await ctx.reply(response.text());
  } catch (error) {
    console.error(error);
    ctx.reply('Kechirasiz, rasmni o\'qishda xatolik yuz berdi. Iltimos, boshqa aniqroq rasm tashlang yoki matn ko\'rinishida yozib yuboring.');
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
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

// /start komandasi bosilganda asosiy menyuni chiqarish
bot.start((ctx) => {
  ctx.reply(
    'Assalomu alaykum! Kerakli bo\'limni tanlang:',
    Markup.keyboard([
      ['👨‍💻 Dasturchi bilan bog\'lanish'],
      ['❓ Savol berish']
    ]).resize()
  );
});

// Dasturchi bilan bog'lanish tugmasi bosilganda
bot.hears('👨‍💻 Dasturchi bilan bog\'lanish', (ctx) => {
  ctx.reply('Dasturchi bilan bog\'lanish uchun: @Abdumalik_Abduxalilov ga yozishingiz mumkin.');
});

// Savol berish tugmasi bosilganda
bot.hears('❓ Savol berish', (ctx) => {
  ctx.reply('Marhamat, o\'zingizni qiziqtirgan savolni yozib yuboring yoki masalaning rasmini tashlang. Men uni qadam-baqadam va oddiy tilda tushuntirib beraman!');
});

// Matnli xabarlar uchun (masala va savollar)
bot.on('text', async (ctx) => {
  const text = ctx.message.text;
  if (text === '👨‍💻 Dasturchi bilan bog\'lanish' || text === '❓ Savol berish') return;

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

// Rasmli xabarlar uchun (masala rasmlari)
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
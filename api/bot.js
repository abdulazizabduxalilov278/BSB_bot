const { Telegraf } = require('telegraf');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');

const bot = new Telegraf(process.env.BOT_TOKEN);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Rasmni yuklab olib Gemini uchun tayyorlash yordamchisi
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
  ctx.reply('Salom! Menga istalgan fandan savol yozishingiz yoki masalaning rasmini tashlashingiz mumkin. Barchasiga to\'liq va tushunarli qilib yechim beraman!');
});

// Matnli xabarlar uchun (istalgan fan)
bot.on('text', async (ctx) => {
  try {
    await ctx.sendChatAction('typing');
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    
    const prompt = `Sen har qanday fan bo'yicha (matematika, fizika, kimyo, biologiya, ona tili, tarix va hokazo) tajribali o'qituvchi va mutaxassissan. Foydalanuvchi yuborgan quyidagi savol yoki masalaga o'zbek tilida aniq, tushunarli va qadam-baqadam to'liq javob ber:\n\n${ctx.message.text}`;
    
    const result = await model.generateContent(prompt);
    const response = await result.response;
    await ctx.reply(response.text());
  } catch (error) {
    console.error(error);
    ctx.reply('Kechirasiz, xatolik yuz berdi. Iltimos, qaytadan urinib ko\'ring.');
  }
});

// Rasmli xabarlar uchun (rasmdagi masalalar)
bot.on('photo', async (ctx) => {
  try {
    await ctx.sendChatAction('typing');
    
    // Rasmning eng sifatli nusxasini olish
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const fileLink = await ctx.telegram.getFileLink(photo.file_id);
    
    // Rasmni yuklab olish
    const imagePart = await urlToGenerativePart(fileLink.href, 'image/jpeg');
    
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    
    const userCaption = ctx.message.caption || 'Bu rasmdagi masalani yoki savolni qaysi fandan bo\'lishidan qat\'iy nazar tushuntirib, to\'liq yechib ber.';
    const prompt = `Sen har qanday fan bo'yicha mutaxassis o'qituvchisan. Ushbu rasmdagi vazifani, masalani yoki savolni diqqat bilan o'qib chiq va to'liq, tushunarli qilib o'zbek tilida yechimini yozib ber.\nFoydalanuvchi izohi: ${userCaption}`;

    const result = await model.generateContent([prompt, imagePart]);
    const response = await result.response;
    await ctx.reply(response.text());
  } catch (error) {
    console.error(error);
    ctx.reply('Rasmni o\'qishda xatolik yuz berdi. Iltimos, boshqa rasm tashlang yoki matn ko\'rinishida yozib yuboring.');
  }
});

// Vercel uchun Serverless eksport
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
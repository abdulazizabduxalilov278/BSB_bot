const { Telegraf } = require('telegraf');
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

bot.start((ctx) => {
  ctx.reply('Salom! Menga istalgan fandan savol yozishingiz yoki masalaning rasmini tashlashingiz mumkin.');
});

bot.on('text', async (ctx) => {
  try {
    await ctx.sendChatAction('typing');
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    const prompt = `Sen har qanday fan bo'yicha mutaxassis o'qituvchisan. Quyidagi savolga o'zbek tilida aniq va tushunarli yechim ber:\n\n${ctx.message.text}`;
    const result = await model.generateContent(prompt);
    const response = await result.response;
    await ctx.reply(response.text());
  } catch (error) {
    console.error(error);
    await ctx.reply(`❌ Matnli xatolik: ${error.message}`);
  }
});

bot.on('photo', async (ctx) => {
  try {
    await ctx.sendChatAction('typing');
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const fileLink = await ctx.telegram.getFileLink(photo.file_id);
    
    const imagePart = await urlToGenerativePart(fileLink.href, 'image/jpeg');
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    
    const userCaption = ctx.message.caption || 'Bu rasmdagi masalani qaysi fandan bo\'lishidan qat\'iy nazar tushuntirib yechib ber.';
    const prompt = `Sen har qanday fan bo'yicha mutaxassis o'qituvchisan. Ushbu rasmdagi vazifani to'liq tushuntirib yechib ber.\nIzoh: ${userCaption}`;

    const result = await model.generateContent([prompt, imagePart]);
    const response = await result.response;
    await ctx.reply(response.text());
  } catch (error) {
    console.error(error);
    // ANIQ SABABINI KO'RSATISH:
    await ctx.reply(`❌ Rasm xatoligi sababi: ${error.message}`);
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
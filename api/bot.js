const { Telegraf, Markup } = require('telegraf');
const { message } = require('telegraf/filters');
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
  ctx.reply(
    '👋 Assalomu alaykum! Botga xush kelibsiz.\n\nBotdan foydalanishni boshlash uchun quyidagi bo\'limlardan birini tanlang:',
    Markup.inlineKeyboard([
      [Markup.button.callback('ℹ️ Bot nima uchun kerak?', 'about_bot')],
      [Markup.button.callback('💎 Donat (VIP) va uning foydasi', 'donate_vip')],
      [Markup.button.callback('👨‍💻 Admin bilan bog\'lanish', 'contact_admin')],
      [Markup.button.callback('🚀 Botni boshlash (Savol berish)', 'start_asking')]
    ])
  );
});

bot.action('about_bot', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('ℹ️ **Bot nima uchun kerak?**\n\nBu bot o\'quvchi va talabalarga BSB, CHSB va istalgan fandan berilgan murakkab vazifalarni yechishda yordam beradi. Siz savolni yozib yuborishingiz yoki rasmga olib tashlashingiz mumkin. Bot qadam-baqadam to\'liq yechim taqdim etadi!');
});

bot.action('donate_vip', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('💎 **Donat (VIP) obunasi va uning afzalliklari:**\n\n• 🚀 **Tezkor va Navbatsiz:** Savollaringizga birinchilardan bo\'lib eng tezkor javobni olasiz.\n• ♾️ **Cheklovsiz:** Kunlik so\'rovlar soniga cheklov qo\'yilmaydi.\n• 🧠 **Super AI:** Eng qiyin olimpiada savollariga ham kengaytirilgan 100% aniq javoblar olasiz.\n\n💳 VIP obuna sotib olish uchun "Admin bilan bog\'lanish" bo\'limiga kiring.');
});

bot.action('contact_admin', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('👨‍💻 **Admin bilan bog\'lanish:**\n\nVIP (Donat) obuna sotib olish yoki taklif/shikoyatlar uchun bevosita dasturchiga yozing: 👉 @XAVIK_ORG');
});

bot.action('start_asking', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('🚀 **Bot ishga tayyor!**\n\nMarhamat, o\'zingizni qiziqtirgan savolni shu yerga yozing yoki masalaning rasmini yuboring. Barchasini ajoyib qilib yechib beraman!');
});

bot.on(message('text'), async (ctx) => {
  const text = ctx.message.text;
  if (text.startsWith('/')) return;

  try {
    await ctx.sendChatAction('typing');
    // Model aniq versiyasi bilan ko'rsatildi
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-pro' });
    
    const prompt = `Sen har qanday fan bo'yicha tajribali o'qituvchisan. Foydalanuvchi yuborgan quyidagi savol yoki masalaga o'zbek tilida oddiy odam tushunadigan qilib, ketma-ketlikda (qadam-baqadam) to'liq yechim ber:\n\n${text}`;
    
    const result = await model.generateContent(prompt);
    const answer = await result.response.text();
    
    if (answer.length > 4000) {
        await ctx.reply(answer.substring(0, 4000) + '\n\n...(Javob juda uzun bo\'lgani uchun qisqartirildi)');
    } else {
        await ctx.reply(answer);
    }
  } catch (error) {
    console.error(error);
    await ctx.reply(`❌ Xatolik yuz berdi: ${error.message}\n(Iltimos, qaytadan yuborib ko'ring)`);
  }
});

bot.on(message('photo'), async (ctx) => {
  try {
    await ctx.sendChatAction('typing');
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const fileLink = await ctx.telegram.getFileLink(photo.file_id);
    
    const imagePart = await urlToGenerativePart(fileLink.href, 'image/jpeg');
    // Model aniq versiyasi bilan ko'rsatildi
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-pro' });
    
    const userCaption = ctx.message.caption || 'Bu rasmdagi masalani yoki savolni qaysi fandan bo\'lishidan qat\'iy nazar oddiy va tushunarli qilib, qadam-baqadam yechib ber.';
    const prompt = `Sen tajribali o'qituvchisan. Ushbu rasmdagi vazifani yoki masalani diqqat bilan o'qib chiq va o'zbek tilida oddiy, tushunarli qilib, ketma-ketlikda (qadam-baqadam) yechimini yozib ber.\nFoydalanuvchi izohi: ${userCaption}`;

    const result = await model.generateContent([prompt, imagePart]);
    const answer = await result.response.text();
    
    if (answer.length > 4000) {
        await ctx.reply(answer.substring(0, 4000) + '\n\n...(Javob qisqartirildi)');
    } else {
        await ctx.reply(answer);
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
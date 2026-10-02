const { Telegraf, Markup } = require('telegraf');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');

const bot = new Telegraf("8847999795:AAFbQR81Q1_GpKPe9eRHG1wThJvkV3r5Vnc");
const genAI = new GoogleGenerativeAI("AIzaSyAb8RN6JQksnA82sMy4-ZRzCHkdf2urD4dNCPUc4Adz87vVkd8g");

bot.start((ctx) => {
    const welcomeText = 
        `👋 **Assalomu alaykum, hurmatli o'quvchi!**\n\n` +
        `🤖 Men sizning shaxsiy sun'iy intellekt yordamchi ustozingizman.\n` +
        `📚 Menga 7, 8 yoki boshqa sinf **BSB / CHSB** vazifalari tushirilgan rasmni yuboring, va men uni qadam-ba-qadam tushuntirib yechib beraman!\n\n` +
        `👇 Kerakli bo'limni tanlang:`;

    ctx.reply(welcomeText, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
            [Markup.button.callback('📌 Qanday foydalanish kerak?', 'help')],
            [Markup.button.callback('💎 VIP Obuna sotib olish', 'vip_info')],
            [Markup.button.url('👨‍💻 Dasturchi bilan bog\'lanish', 'https://t.me/XAVIK_ORG')]
        ])
    });
});

bot.action('help', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(
        `📖 **Botdan foydalanish yo'riqnomasi:**\n\n` +
        `1️⃣ Test yoki masala tushirilgan qog'ozni yaxshi yoritilgan holda rasmga oling.\n` +
        `2️⃣ Rasmni to'g'ridan-to'g'ri ushbu botga yuboring.\n` +
        `3️⃣ 10-15 soniya kuting va sun'iy intellekt bergan batafsil yechimni o'qing!`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Orqaga', 'back_home')]])
        }
    );
});

bot.action('vip_info', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(
        `💎 **VIP Obuna Imkoniyatlari:**\n\n` +
        `✨ **Cheklovsiz yechimlar:** Kunlik so'rovlar soniga cheklov yo'q.\n` +
        `⚡ **Ustuvor navbat:** Masalalar birinchilar qatorida juda tez tahlil qilinadi.\n` +
        `🎯 **Yuqori aniqlik:** Murakkab va qo'lyozma rasmlarni mukammal o'qish.\n\n` +
        `💰 **Narxi:** 15,000 so'm / oy\n\n` +
        `👇 VIP statusini olish uchun adminga yozing:`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.url('💳 Obuna sotib olish (Admin)', 'https://t.me/XAVIK_ORG')],
                [Markup.button.callback('🔙 Orqaga', 'back_home')]
            ])
        }
    );
});

bot.action('back_home', async (ctx) => {
    await ctx.answerCbQuery();
    const welcomeText = `👋 **Asosiy menyu:**\n\n📚 BSB va CHSB vazifalarini yechish uchun rasm yuboring:`;
    await ctx.editMessageText(welcomeText, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
            [Markup.button.callback('📌 Qanday foydalanish kerak?', 'help')],
            [Markup.button.callback('💎 VIP Obuna sotib olish', 'vip_info')],
            [Markup.button.url('👨‍💻 Dasturchi bilan bog\'lanish', 'https://t.me/XAVIK_ORG')]
        ])
    });
});

bot.on('photo', async (ctx) => {
    let waitMessage;
    try {
        waitMessage = await ctx.reply("📸 Rasm qabul qilindi.\n⏳ *AI yechim tayyorlamoqda...*", { parse_mode: 'Markdown' });
        
        const photo = ctx.message.photo.pop();
        const fileLink = await bot.telegram.getFileLink(photo.file_id);
        
        const response = await axios.get(fileLink.href, { responseType: 'arraybuffer', timeout: 30000 });
        const imageBuffer = Buffer.from(response.data, 'binary');

        const imagePart = {
            inlineData: { data: imageBuffer.toString("base64"), mimeType: "image/jpeg" },
        };

        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash"});
        const prompt = "Sen maktab o'quvchilari uchun BSB va CHSB vazifalarini yechuvchi tajribali ustozsan. Rasmda berilgan savollarni aniq, qadam-ba-qadam yechib ber.";

        const result = await model.generateContent([prompt, imagePart]);
        const aiResponse = await result.response.text();

        if (waitMessage) try { await ctx.telegram.deleteMessage(ctx.chat.id, waitMessage.message_id); } catch (e) {}
        await ctx.reply(`✅ **Topshiriq yechimi:**\n\n${aiResponse}`, { parse_mode: 'Markdown' });

    } catch (error) {
        if (waitMessage) try { await ctx.telegram.deleteMessage(ctx.chat.id, waitMessage.message_id); } catch (e) {}
        ctx.reply("⚠️ Xatolik yuz berdi. Iltimos qayta urinib ko'ring.");
    }
});

// Vercel Webhook eksporti
module.exports = async (req, res) => {
    try {
        if (req.method === 'POST') {
            await bot.handleUpdate(req.body);
        }
        res.status(200).send('Bot Vercel serverida aktiv!');
    } catch (error) {
        console.error('Webhook xatosi:', error);
        res.status(500).send('Error');
    }
};
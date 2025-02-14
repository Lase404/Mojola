require('dotenv').config();
const { Telegraf, Markup, Scenes, session } = require('telegraf');
const axios = require('axios');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs').promises;
const BOT_TOKEN = process.env.BOT_TOKEN
const bot = new Telegraf(BOT_TOKEN);

// Express for handling webhooks if needed
const app = express();
app.use(helmet());

// Rate Limiting for API requests
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // Limit each IP to 100 requests per windowMs
});
app.use('/api', limiter);

// Language support with sample text for language preview
const languages = {
  'Arabic': ['Arabic', 'مرحبًا، كيف حالك؟'],
  'Baby': ['Baby', 'Goo goo, ga ga?'],
  'Chinese-Simplified': ['Chinese-Simplified', '你好，你好吗？'],
  'Chinese-Traditional': ['Chinese-Traditional', '你好，你好嗎？'],
  'Czech': ['Czech', 'Ahoj, jak se máš?'],
  'Danish': ['Danish', 'Hej, hvordan går det?'],
  'Dutch': ['Dutch', 'Hoi, hoe gaat het?'],
  'English': ['English', 'Hello, how are you?'],
  'Finnish': ['Finnish', 'Hei, mitä kuuluu?'],
  'French': ['French', 'Bonjour, comment vas-tu?'],
  'Gen-Z': ['Gen-Z', 'Hey, you good?'],
  'German': ['German', 'Hallo, wie geht es dir?'],
  'Greek': ['Greek', 'Γεια σου, πώς είσαι;'],
  'Hindi': ['Hindi', 'नमस्ते, आप कैसे हैं?'],
  'Hinglish': ['Hinglish', 'Hello, kaise ho?'],
  'Indonesian': ['Indonesian', 'Halo, apa kabar?'],
  'Italian': ['Italian', 'Ciao, come stai?'],
  'Japanese': ['Japanese', 'こんにちは、元気ですか？'],
  'Korean': ['Korean', '안녕, 잘 지내?'],
  'Malay': ['Malay', 'Helo, apa khabar?'],
  'Pirate': ['Pirate', 'Ahoy, how be ye farin\'?'],
  'Polish': ['Polish', 'Cześć, jak się masz?'],
  'Portuguese': ['Portuguese', 'Olá, como você está?'],
  'Romanian': ['Romanian', 'Bună, ce mai faci?'],
  'Russian': ['Russian', 'Привет, как дела?'],
  'Slovak': ['Slovak', 'Ahoj, ako sa máš?'],
  'Spanish': ['Spanish', 'Hola, ¿cómo estás?'],
  'Swedish': ['Swedish', 'Hej, hur mår du?'],
  'Tamil': ['Tamil', 'வணக்கம், எப்படி இருக்கிறீர்கள்?'],
  'Texan': ['Texan', 'Howdy, y\'all doin\'?'],
  'Turkish': ['Turkish', 'Merhaba, nasılsın?'],
  'Ukrainian': ['Ukrainian', 'Привіт, як справи?']
};

// Function to create language keyboard with samples
function createLanguageKeyboard(ctx, excludeLang = null) {
  const keyboard = Object.keys(languages).filter(lang => lang !== excludeLang).map(lang => {
    const [name, sample] = languages[lang];
    return [`${name}\n${sample}`];
  });
  return Markup.keyboard(keyboard).resize();
}

// Scene for handling video translation process
const translationScene = new Scenes.WizardScene(
  'translation_wizard',
  async (ctx) => {
    ctx.reply('📹 Please upload the video you want to translate with senSEI.', Markup.keyboard([
      ['Cancel ❌']
    ]).resize().extra({
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('Cancel Process', 'cancel_video_translation')]
      ])
    }));
    return ctx.wizard.next();
  },
  async (ctx) => {
    if (ctx.message && ctx.message.video) {
      const videoFile = await ctx.telegram.getFile(ctx.message.video.file_id);
      ctx.session.videoUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${videoFile.file_path}`;
      ctx.session.videoMetadata = ctx.message.video;
      ctx.reply('Video received. Now, select the original language:', createLanguageKeyboard(ctx), Markup.inlineKeyboard([
        [Markup.button.callback('Cancel Process', 'cancel_video_translation')]
      ]));
      return ctx.wizard.next();
    }
    if (ctx.message && ctx.message.text === 'Cancel ❌') {
      ctx.reply('Translation process canceled. 🚫', Markup.removeKeyboard());
      return ctx.scene.leave();
    }
    ctx.reply('Please upload a video file. 📹', Markup.inlineKeyboard([
      [Markup.button.callback('Cancel Process', 'cancel_video_translation')]
    ]));
  },
  async (ctx) => {
    if (ctx.callbackQuery && ctx.callbackQuery.data === 'cancel_video_translation') {
      ctx.reply('Translation process canceled. 🚫', Markup.removeKeyboard());
      return ctx.scene.leave();
    }
    const selectedLang = ctx.message.text.split('\n')[0];  // Split to remove sample text
    if (Object.keys(languages).includes(selectedLang)) {
      ctx.session.originalLanguage = selectedLang; // Use full language name
      ctx.reply('Now select the target language for translation:', createLanguageKeyboard(ctx, selectedLang), Markup.inlineKeyboard([
        [Markup.button.callback('Cancel Process', 'cancel_video_translation')]
      ]));
      return ctx.wizard.next();
    }
    ctx.reply('Please select from the list of supported languages. 🌐', Markup.inlineKeyboard([
      [Markup.button.callback('Cancel Process', 'cancel_video_translation')]
    ]));
  },
  async (ctx) => {
    if (ctx.callbackQuery && ctx.callbackQuery.data === 'cancel_video_translation') {
      ctx.reply('Translation process canceled. 🚫', Markup.removeKeyboard());
      return ctx.scene.leave();
    }
    const targetLang = ctx.message.text.split('\n')[0];
    if (Object.keys(languages).includes(targetLang)) {
      ctx.session.targetLanguage = targetLang; // Use full language name
      ctx.reply('Translation started with senSEI. Please wait... ⏳', Markup.inlineKeyboard([
        [Markup.button.callback('Check Status 🔄', `checkStatus_${ctx.session.operationId}`)]
      ]));

      try {
        const translateResponse = await axios.post('https://api.captions.ai/api/translate/submit', {
          videoUrl: ctx.session.videoUrl,
          sourceLanguage: ctx.session.originalLanguage,
          targetLanguage: ctx.session.targetLanguage,
          translateAudioOnly: true
        }, {
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': process.env.AI_TRANSLATE_API_KEY
          }
        });

        ctx.session.operationId = translateResponse.data.operationId;
        ctx.session.polled = false; // Initialize polling state
        pollForResult(ctx);
      } catch (error) {
        console.error('Translation error:', error.response?.data || error.message);
        ctx.reply(`An error occurred during translation. Please try again. If the problem persists, it might be a temporary issue with our service.`, Markup.removeKeyboard());
        return ctx.scene.leave();
      }
    } else {
      ctx.reply('Please select from the list of supported languages. 🌐', Markup.inlineKeyboard([
        [Markup.button.callback('Cancel Process', 'cancel_video_translation')]
      ]));
    }
  }
);

// Function to download video from URL
async function downloadVideo(url, chatId) {
  try {
    const response = await axios({
      method: 'GET',
      url: url,
      responseType: 'stream'
    });

    const fileName = `translated_video_${Date.now()}.mp4`;
    const filePath = path.join(__dirname, 'temp', fileName);

    // Create the temp directory if it doesn't exist
    await fs.mkdir(path.join(__dirname, 'temp'), { recursive: true });

    const writer = fs.createWriteStream(filePath);

    await new Promise((resolve, reject) => {
      response.data.pipe(writer);
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    return filePath;
  } catch (error) {
    console.error('Error downloading video:', error);
    ctx.reply("An error occurred while downloading the translated video.");
    throw error;
  }
}

// Function to poll for translation results (for video)
async function pollForResult(ctx) {
  setTimeout(async () => {
    try {
      const pollResponse = await axios.post('https://api.captions.ai/api/translate/poll', {
        operationId: ctx.session.operationId
      }, {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.AI_TRANSLATE_API_KEY
        }
      });

      if (pollResponse.data.state === 'COMPLETE') {
        const translatedVideoUrl = pollResponse.data.url;
        let filePath;
        try {
          filePath = await downloadVideo(translatedVideoUrl, ctx.from.id);
          await ctx.replyWithVideo({ source: filePath }, { 
            caption: `Translation from ${ctx.session.originalLanguage} to ${ctx.session.targetLanguage} completed by senSEI! ✅`
          });
          ctx.reply('Was this translation helpful?\n[Yes ✅] [No ❌]', Markup.keyboard([
            ['Yes ✅', 'No ❌']
          ]).resize());
          
          // Clean up the temporary file
          await fs.unlink(filePath);
        } catch (downloadOrSendError) {
          console.error('Failed to download or send video:', downloadOrSendError);
          ctx.reply(`Failed to send the video directly. You can download it from this URL:\n${translatedVideoUrl}`, {
            parse_mode: 'Markdown'
          });
          ctx.reply('Was this translation helpful?\n[Yes ✅] [No ❌]', Markup.keyboard([
            ['Yes ✅', 'No ❌']
          ]).resize());
        }
        ctx.scene.leave();
      } else {
        const progress = pollResponse.data.progress || 0;
        ctx.editMessageText(`Translation in progress with senSEI... ⏳ [${'='.repeat(Math.floor(progress / 10))}>${' '.repeat(10 - Math.floor(progress / 10))} ${progress}%]`, Markup.inlineKeyboard([
          [Markup.button.callback('Check Status 🔄', `checkStatus_${ctx.session.operationId}`)]
        ]));
        ctx.session.polled = true; // Set polled to true after first check
        pollForResult(ctx);
      }
    } catch (error) {
      console.error('Polling error:', error.response?.data || error.message);
      ctx.reply('An error occurred while checking translation status. Please try again.', Markup.removeKeyboard());
      ctx.scene.leave();
    }
  }, ctx.session.polled ? 5000 : 30000); // Poll after 30 seconds first time, then every 5 seconds
}

// Handle status check callback for video translation
bot.action(/checkStatus_(.+)/, async (ctx) => {
  const operationId = ctx.match[1];
  try {
    const pollResponse = await axios.post('https://api.captions.ai/api/translate/poll', {
      operationId: operationId
    }, {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.AI_TRANSLATE_API_KEY
      }
    });
    if (pollResponse.data.state === 'COMPLETE') {
      ctx.editMessageText('Translation has been completed by senSEI! ✅', Markup.keyboard([
        ['Translate Video 📹', 'About SEI 🌍', 'Help ❓']
      ]).resize());
    } else {
      const progress = pollResponse.data.progress || 0;
      ctx.editMessageText(`Translation still in progress with senSEI... ⏳ [${'='.repeat(Math.floor(progress / 10))}>${' '.repeat(10 - Math.floor(progress / 10))} ${progress}%]`, Markup.inlineKeyboard([
        [Markup.button.callback('Check Status 🔄', `checkStatus_${operationId}`)]
      ]));
    }
  } catch (error) {
    ctx.reply('Failed to check status. Please try again later. ⚠️', Markup.keyboard([
      ['Translate Video 📹', 'About SEI 🌍', 'Help ❓']
    ]).resize());
  }
});

// Handle cancel actions for video translation
bot.action('cancel_video_translation', (ctx) => {
  ctx.reply('Video translation process canceled by senSEI. 🚫', Markup.keyboard([
    ['Translate Video 📹', 'About SEI 🌍', 'Help ❓']
  ]).resize());
  ctx.scene.leave();
});

// Register scenes
const stage = new Scenes.Stage([translationScene]);
bot.use(session());
bot.use(stage.middleware());

// Start command with enhanced welcome message
bot.start((ctx) => {
  ctx.reply('Welcome to senSEI, powered by SEI! 🎉\n\nHere you can:\n- Translate videos into different languages 🎥\n\nExamples:\n- Use /translate for video translation\n\nUse these commands:', Markup.keyboard([
    ['Translate Video 📹', 'About SEI 🌍', 'Help ❓']
  ]).resize());
});

// Help command
bot.command('help', (ctx) => {
  ctx.reply('🔍 Help Guide:\n\n- /translate - Start translating a video\n- /about - Learn about SEI\n\n**Tips:**\n- Cancel any process with the inline button at each step.\n- For video translations, ensure your video is public or follows the upload guidelines.', Markup.keyboard([
    ['Translate Video 📹', 'About SEI 🌍', 'Help ❓']
  ]).resize());
});

// About SEI command
bot.command('about', (ctx) => {
  ctx.reply('About SEI 🌍\n\nSEI is a technology that aims to revolutionize how we interact with digital content, focusing on decentralization, privacy, and ease of use. senSEI leverages SEI to provide you with cutting-edge translation services without complex blockchain interactions.', Markup.keyboard([
    ['Translate Video 📹', 'About SEI 🌍', 'Help ❓']
  ]).resize());
});

// Feedback handling
bot.hears(['Yes ✅', 'No ❌'], (ctx) => {
  const feedback = ctx.message.text === 'Yes ✅' ? 'positive' : 'negative';
  ctx.reply(`Thank you for your ${feedback} feedback on senSEI!`, Markup.keyboard([
    ['Translate Video 📹', 'About SEI 🌍', 'Help ❓']
  ]).resize());
});

// Command to initiate video translation
bot.hears('Translate Video 📹', (ctx) => {
  ctx.scene.enter('translation_wizard');
});

// Set webhook
const WEBHOOK_URL = process.env.WEBHOOK_URL
bot.telegram.setWebhook(`${WEBHOOK_URL}/webhook/telegram`);

// Handle incoming updates from Telegram
app.post('/webhook/telegram', (req, res) => {
  bot.handleUpdate(req.body);
  res.sendStatus(200);
});
const PORT = 4000

// =================== Start Express Server ===================
const bodyParser = require('body-parser');
const WEBHOOK_PATH = '/webhook/telegram';
app.use(WEBHOOK_PATH, bodyParser.json());

// Manually fetch bot info and set the webhook
(async () => {
  try {
    const botInfo = await bot.telegram.getMe();
    bot.botInfo = botInfo;  // Set botInfo manually
    console.log(`Bot started as @${botInfo.username}`);

    await bot.telegram.setWebhook(`${WEBHOOK_URL}/webhook/telegram`);
  } catch (error) {
    console.error('Error fetching bot info:', error);
  }
})();

// Handle the webhook update
app.post(WEBHOOK_PATH, bodyParser.json(), (req, res) => {
  if (!req.body) {
    console.error('No body found in Telegram webhook request.');
    return res.status(400).send('No body found.');
  }

  console.log(`Received Telegram update: ${JSON.stringify(req.body, null, 2)}`); // Debugging

  bot.handleUpdate(req.body, res);  // Handle the incoming update
});

// Start Express Server
app.listen(PORT, () => { 
  console.log(`Webhook server running on port ${PORT}`); 
});

// Graceful shutdown
const gracefulShutdown = () => {
  bot.stop('SIGINT');
  process.exit();
};

process.once('SIGINT', gracefulShutdown);
process.once('SIGTERM', gracefulShutdown);

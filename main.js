require('dotenv').config();
const { Agent } = require('@fileverse/agents');
const TelegramBot = require('node-telegram-bot-api');
const Twitter = require('twitter-v2');
const Sentiment = require('sentiment'); // New import for sentiment analysis
const { ethers } = require('ethers');
const Safe = require('@safe-global/protocol-kit');
const { EthersAdapter } = require('@safe-global/safe-ethers-lib');
const { 
  FeeAmount,
  Pool,
  Route,
  SwapRouter,
  CurrencyAmount,
  TradeType,
  Percent
} = require('@uniswap/v3-sdk');
const { Token } = require('@uniswap/sdk-core');
const JSBI = require('jsbi');
const { 
  createPublicClient,
  createWalletClient,
  http,
  encodeFunctionData,
} = require('viem');
const CoinGecko = require('coingecko-api');
const CoinGeckoClient = new CoinGecko();
const NewsAPI = require('newsapi');
const newsapi = new NewsAPI(process.env.NEWS_API_KEY);
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

// Initialize Express for potential webhooks or API endpoints
const app = express();
app.use(helmet());
app.use(express.json());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // Limit each IP to 100 requests per windowMs
});
app.use(limiter);

// Initialize Fileverse Agent
const agent = new Agent({
  chain: process.env.CHAIN,
  privateKey: process.env.AGENT_PRIVATE_KEY,
  pinataJWT: process.env.PINATA_JWT,
  pinataGateway: process.env.PINATA_GATEWAY,
  pimlicoAPIKey: process.env.PIMLICO_API_KEY,
});

// Twitter Client v2 API
const twitterClient = new Twitter({
  bearer_token: process.env.TWITTER_BEARER_TOKEN
});

// Telegram Bot
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

// Bot Performance Metrics
let botStats = {
  startTime: new Date(),
  tradesExecuted: 0,
  sentimentAccuracy: 0, // Placeholder, should be calculated based on historical data
  lastUpdate: new Date()
};

// User Data Structure
const userData = new Map(); // Using Map for better performance with large datasets

// List of assets for interactive selection
const assets = [
  'BTC', 'ETH', 'USDT', 'XRP', 'SOL', 'BNB', 'USDC', 'DOGE', 'ADA', 'TRX', 
  'LINK', 'DOT', 'MATIC', 'LTC', 'BCH', 'UNI', 'VET', 'XLM', 'ATOM', 'FIL'
];

// Language Support
const languages = {
  'en': 'English',
  'es': 'Español',
  // Add more languages
};

// Initialize storage for the bot's namespace
async function initializeStorage() {
  try {
    await agent.setupStorage('bot-namespace');
    console.log('Storage initialized successfully for bot namespace');
  } catch (error) {
    console.error('Failed to initialize storage:', error);
    throw error;
  }
}

// Store agent key securely
async function storeAgentKey(chatId, encryptedKey, agentAddress) {
  try {
        const data = JSON.stringify({
      chatId: chatId,
      encryptedKey: encryptedKey,
      agentAddress: agentAddress
    });
    const file = await agent.create(data, { fileName: `agent_${chatId}.json`, encrypt: true });
    console.log(`Agent key stored securely for user ${chatId}: File ID - ${file.fileId}`);
    return file.fileId;
  } catch (error) {
    console.error(`Error storing agent key for user ${chatId}:`, error);
    throw error;
  }
}

// Retrieve agent key from storage
async function retrieveAgentKeyFromStorage(chatId) {
  try {
    const file = await agent.getFile(`agent_${chatId}.json`, { decrypt: true });
    if (file) {
      return JSON.parse(file);
    } else {
      throw new Error(`No file found for user ${chatId}`);
    }
  } catch (error) {
    console.error(`Error retrieving agent key for user ${chatId}:`, error);
    throw error;
  }
}

// Retrieve agent address from storage
async function retrieveAgentAddressFromStorage(chatId) {
  try {
    const { agentAddress } = await retrieveAgentKeyFromStorage(chatId);
    return agentAddress;
  } catch (error) {
    console.error(`Error retrieving agent address for user ${chatId}:`, error);
    throw error;
  }
}

// Get or create user's Safe address
async function getUserSafeAddress(chatId) {
  try {
    let safeAddress = await agent.getSafeAddress(chatId);
    if (!safeAddress) {
      const newSafe = await agent.createSafe(chatId);
      safeAddress = newSafe.address;
      // Store the new Safe address
      await storeSafeAddress(chatId, safeAddress);
    }
    return safeAddress;
  } catch (error) {
    console.error(`Error getting or creating Safe address for user ${chatId}:`, error);
    throw error;
  }
}

// Store Safe address
async function storeSafeAddress(chatId, safeAddress) {
  try {
    const data = JSON.stringify({ chatId, safeAddress });
    const file = await agent.create(data, { fileName: `safe_${chatId}.json`, encrypt: true });
    console.log(`Safe address stored securely for user ${chatId}: File ID - ${file.fileId}`);
    return file.fileId;
  } catch (error) {
    console.error(`Error storing Safe address for user ${chatId}:`, error);
    throw error;
  }
}

// Initialize Safe Smart Account
async function initializeSafe(chatId) {
  try {
    const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL);
    const signer = new ethers.Wallet(getAgentPrivateKey(chatId), provider);
    const ethAdapter = new EthersAdapter({ ethers, signer });
    const safeAddress = await getUserSafeAddress(chatId);
    return await Safe.init({ ethAdapter, safeAddress: safeAddress });
  } catch (error) {
    console.error(`Error initializing Safe for user ${chatId}:`, error);
    throw error;
  }
}

// Fetch Uniswap pool data
async function fetchPoolData(publicClient, poolAddress) {
  try {
    const slot0 = await publicClient.readContract({
      address: poolAddress,
      abi: POOL_ABI,
      functionName: 'slot0',
    });

    const liquidity = await publicClient.readContract({
      address: poolAddress,
      abi: POOL_ABI,
      functionName: 'liquidity',
    });

    return {
      sqrtPriceX96: BigInt(slot0[0]),
      liquidity: BigInt(liquidity),
      tick: slot0[1],
    };
  } catch (error) {
    console.error('Error fetching pool data:', error);
    throw error;
  }
}

// Function to analyze sentiment
const sentimentAnalyzer = new Sentiment();
function analyzeSentiment(text) {
  try {
    const result = sentimentAnalyzer.analyze(text);
    return result.score;
  } catch (error) {
    console.error('Error analyzing sentiment:', error);
    throw error;
  }
}

// Function to fetch tweets and analyze sentiment with Twitter v2 API
async function fetchAndAnalyzeTweets(query, max_results = 100) {
  try {
    const tweets = await twitterClient.get('tweets/search/recent', {
      query: query,
      max_results: max_results,
      "tweet.fields": 'created_at,public_metrics' // Use quotes around the property name
    });
    const sentiments = tweets.data.map(tweet => analyzeSentiment(tweet.text));
    const avgSentiment = sentiments.reduce((sum, score) => sum + score, 0) / sentiments.length;
    return avgSentiment;
  } catch (error) {
    console.error('Error fetching tweets:', error);
    throw error;
  }
}

// Store sentiment data on IPFS
async function storeSentimentData(asset, sentimentData) {
  try {
    const markdownData = `### Market Sentiment Analysis for ${asset}\n\n- **Average Sentiment**: ${sentimentData}\n\n${JSON.stringify(sentimentData, null, 2)}`;
    const file = await agent.create(markdownData);
    console.log(`Sentiment data for ${asset} stored with fileId: ${file.fileId}`);
    return file.fileId;
  } catch (error) {
    console.error('Error storing sentiment data:', error);
    throw error;
  }
}

// Fetch price data
async function fetchPriceData(asset) {
  try {
    const data = await CoinGeckoClient.simple.price({
      ids: asset.toLowerCase(),
      vs_currencies: 'usd'
    });
    return data.data[asset.toLowerCase()].usd;
  } catch (error) {
    console.error('Error fetching price data:', error);
    throw error;
  }
}

// Execute Swap
async function executeSwap(sentimentScore, asset, chatId) {
  try {
    const preExistingSafe = await initializeSafe(chatId);
    
    // Setup viem clients
    const publicClient = createPublicClient({
      transport: http(process.env.RPC_URL)
    });
    const walletClient = createWalletClient({
      transport: http(process.env.RPC_URL),
      account: ethers.utils.computeAddress(getAgentPrivateKey(chatId))
    });

    const chainId = await publicClient.getChainId();

    // Example Values for WETH/USDC Uniswap Pool on Ethereum Sepolia:
    const WETH_ADDRESS = "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14";
    const USDC_ADDRESS = "0xBe72e441BF55620FEBcC26715DB68d3494213D8C";
    const USDC_ETH_POOL_ADDRESS = "0x9799b5edc1aa7d3fad350309b08df3f64914e244";
    const SWAP_ROUTER_ADDRESS = "0xc532a74256d3db42d0bf7a0400fefdbad7694008"; // Uniswap V3 Router
    const INPUT_AMOUNT = sentimentScore > 0 ? ethers.utils.parseEther("0.1").toString() : "0"; // Amount of ETH to swap to USDC based on sentiment
    const OUTPUT_AMOUNT = sentimentScore > 0 ? "0" : ethers.utils.parseEther("0.1").toString(); // Amount of USDC if selling

    // Define token details
    const USDC = new Token(chainId, USDC_ADDRESS, 6, 'USDC', 'USD Coin');
    const WETH = new Token(chainId, WETH_ADDRESS, 18, 'WETH', 'Wrapped Ether');

    // Approve WETH for Uniswap Router
    const callDataApprove = encodeFunctionData({
      abi: WETH_ABI,
      functionName: 'approve',
      args: [SWAP_ROUTER_ADDRESS, INPUT_AMOUNT],
    });

    const safeApproveTx = {
      to: WETH_ADDRESS,
      value: "0",
      data: callDataApprove,
      operation: 0, // Call
    };

    // Set swap options
    const options = {
      slippageTolerance: new Percent(50, 10_000), // 0.50% slippage
      deadline: Math.floor(Date.now() / 1000) + 60 * 20, // 20 minutes from now
      recipient: await getUserSafeAddress(chatId),
    };

    // Fetch pool data
    const poolInfo = await fetchPoolData(publicClient, USDC_ETH_POOL_ADDRESS);

    // Create the pool object
    const pool = new Pool(
      WETH,
      USDC,
      FeeAmount.MEDIUM,
      poolInfo.sqrtPriceX96,
      poolInfo.liquidity,
      poolInfo.tick
    );

    const swapRoute = new Route([pool], sentimentScore > 0 ? WETH : USDC, sentimentScore > 0 ? USDC : WETH);
    
    const uncheckedTrade = Trade.createUncheckedTrade({
      route: swapRoute,
      inputAmount: CurrencyAmount.fromRawAmount(sentimentScore > 0 ? WETH : USDC, INPUT_AMOUNT),
      outputAmount: CurrencyAmount.fromRawAmount(sentimentScore > 0 ? USDC : WETH, OUTPUT_AMOUNT),
      tradeType: sentimentScore > 0 ? TradeType.EXACT_INPUT : TradeType.EXACT_OUTPUT,
    });

    const methodParameters = SwapRouter.swapCallParameters([uncheckedTrade], options);

    const safeSwapTx = {
      to: SWAP_ROUTER_ADDRESS,
      value: methodParameters.value.toString(),
      data: methodParameters.calldata,
      operation: 0, // Call
    };

    // Combine transactions
    const safeTx = await preExistingSafe.createTransaction({
      transactions: [safeApproveTx, safeSwapTx],
      onlyCalls: true,
    });

    // Execute the transaction through Safe
    const txResponse = await preExistingSafe.executeTransaction(safeTx);
    await publicClient.waitForTransactionReceipt({ hash: txResponse.hash });
    botStats.tradesExecuted++;
    botStats.lastUpdate = new Date();
    console.log(`Swap transaction executed: [${txResponse.hash}]`);
    return txResponse.hash;
  } catch (error) {
    console.error('Error executing swap:', error);
    throw error;
  }
}

// Function to record trade details
function recordTrade(chatId, asset, status, id, timeframe, entryPrice, exitPrice, pnlPercentage) {
  try {
    if (!userData.has(chatId)) userData.set(chatId, { tradeHistory: [] });
    const user = userData.get(chatId);
    
    const trade = {
      currency: asset,
      pnl: `${pnlPercentage > 0 ? '+' : ''}${pnlPercentage.toFixed(4)}%`,
      status: status,
      id: id,
      timeframe: timeframe,
      timestamp: new Date().toISOString(),
      entryPrice: entryPrice.toFixed(2),
      exitPrice: exitPrice.toFixed(2)
    };
    
    user.tradeHistory.push(trade);
    
    // Sort trades by ID in descending order for the latest at the top
    user.tradeHistory.sort((a, b) => b.id - a.id);
  } catch (error) {
    console.error('Error recording trade:', error);
    throw error;
  }
}

// Function to calculate total PNL
function calculateTotalPNL(chatId) {
  try {
    if (!userData.has(chatId) || userData.get(chatId).tradeHistory.length === 0) return '0.00%';
    
    const totalPNL = userData.get(chatId).tradeHistory.reduce((sum, trade) => {
      const pnlValue = parseFloat(trade.pnl.replace('%', '')) / 100;
      return sum + pnlValue;
    }, 0);
    
    return `${(totalPNL * 100).toFixed(4)}%`;
  } catch (error) {
    console.error('Error calculating total PNL:', error);
    throw error;
  }
}

// Function to convert sentiment score to percentage
function convertSentimentScoreToPercentage(sentimentScore) {
  try {
    return ((sentimentScore + 5) / 10) * 100; // Sentiment score from -5 to 5, convert to 0-100%
  } catch (error) {
    console.error('Error converting sentiment score to percentage:', error);
    throw error;
  }
}

// Function to map percentage to PNL card scale (1-100)
function mapToPNLCardScale(percentage) {
  try {
    return Math.round(100 - (percentage / 100) * 99);
  } catch (error) {
    console.error('Error mapping to PNL card scale:', error);
    throw error;
  }
}

// Function to manage portfolio based on sentiment
async function managePortfolio(userId, sentimentData) {
  try {
    if (!userData.has(userId)) userData.set(userId, { portfolio: { 'BTC': 50, 'ETH': 50 } });
    const portfolio = userData.get(userId).portfolio;
    
    Object.keys(portfolio).forEach(asset => {
      if (sentimentData[asset] > 0.2) {
        portfolio[asset] += 10;
      } else if (sentimentData[asset] < -0.2) {
        portfolio[asset] = Math.max(0, portfolio[asset] - 10);
      }
      // Normalize portfolio to 100%
      const total = Object.values(portfolio).reduce((a, b) => a + b, 0);
      Object.keys(portfolio).forEach(a => {
        portfolio[a] = (portfolio[a] / total) * 100;
      });
    });

    userData.get(userId).portfolio = portfolio;
    return portfolio;
  } catch (error) {
    console.error('Error managing portfolio:', error);
    throw error;
  }
}

// Function to analyze correlation between assets
async function analyzeCorrelation(asset1, asset2) {
  try {
    const [sentimentData1, sentimentData2] = await Promise.all([
      agent.getHistoricalData(asset1),
      agent.getHistoricalData(asset2)
    ]);

    // Simplified correlation calculation, placeholder for actual implementation
    const correlation = calculateCorrelation(sentimentData1.map(d => d.sentiment), sentimentData2.map(d => d.sentiment));
    return correlation;
  } catch (error) {
    console.error('Error analyzing correlation:', error);
    throw error;
  }
}

function calculateCorrelation(data1, data2) {
  try {
    // Placeholder for actual correlation calculation
    return Math.random(); // Replace with proper correlation calculation method like Pearson's correlation
  } catch (error) {
    console.error('Error calculating correlation:', error);
    throw error;
  }
}

// Function to get bot performance metrics
function getBotStats() {
  try {
    const uptimeInHours = Math.round((new Date() - botStats.startTime) / 3600000);
    return {
      uptime: uptimeInHours,
      tradesExecuted: botStats.tradesExecuted,
      sentimentAccuracy: botStats.sentimentAccuracy,
      lastUpdate: botStats.lastUpdate.toLocaleString()
    };
  } catch (error) {
    console.error('Error getting bot stats:', error);
    throw error;
  }
}

// Function to execute trades considering profit and stop-loss
async function executeTrade(sentimentScore, asset, currentPrice, buyPrice, chatId) {
  try {
    const user = userData.get(chatId);
    let profitThreshold = user?.profitThreshold || 20; // Default to 20% if not set
    let stopLossThreshold = user?.stopLossThreshold || 10; // Default to 10% if not set

    // Check for profit taking
    const profitPercentage = ((currentPrice - buyPrice) / buyPrice) * 100;
    if (profitPercentage >= profitThreshold) {
      const txHash = await executeSwap(sentimentScore, asset, chatId);
      recordTrade(chatId, asset, 'CLOSED', Date.now(), '15m', buyPrice, currentPrice, profitPercentage);
      bot.sendMessage(chatId, `Profit taken on ${asset}. Profit: ${profitPercentage.toFixed(2)}%. Transaction Hash: ${txHash}`);
      return;
    }

    // Check for stop-loss
    const lossPercentage = ((buyPrice - currentPrice) / buyPrice) * 100;
    if (lossPercentage >= stopLossThreshold) {
      const txHash = await executeSwap(sentimentScore, asset, chatId);
      recordTrade(chatId, asset, 'CLOSED', Date.now(), '15m', buyPrice, currentPrice, -lossPercentage);
      bot.sendMessage(chatId, `Loss cut on ${asset}. Loss: ${lossPercentage.toFixed(2)}%. Transaction Hash: ${txHash}`);
      return;
    }

    // If neither profit nor stop-loss conditions are met, proceed with sentiment-based decision
    if (sentimentScore <= (user?.thresholds?.sell || -1.5) || sentimentScore <= -1.5) { // Adjust thresholds for sentiment library
      const txHash = await executeSwap(sentimentScore, asset, chatId);
      const pnlPercentage = ((currentPrice - buyPrice) / buyPrice) * 100;
      recordTrade(chatId, asset, 'CLOSED', Date.now(), '15m', buyPrice, currentPrice, pnlPercentage);
      bot.sendMessage(chatId, `Sold ${asset} due to negative sentiment. PNL: ${pnlPercentage > 0 ? '+' : ''}${pnlPercentage.toFixed(2)}%. Transaction Hash: ${txHash}`);
    } else if (sentimentScore >= (user?.thresholds?.buy || 1.5) || sentimentScore >= 1.5) { // Adjust thresholds for sentiment library
      const txHash = await executeSwap(sentimentScore, asset, chatId);
      recordTrade(chatId, asset, 'OPEN', Date.now(), '15m', currentPrice, 0, 0);
      bot.sendMessage(chatId, `Bought ${asset} due to positive sentiment. Transaction Hash: ${txHash}`);
    }
  } catch (error) {
    console.error('Error executing trade:', error);
    bot.sendMessage(chatId, 'An error occurred while executing your trade.');
  }
}

// Function to encrypt the private key
function encryptKey(key) {
  try {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(process.env.ENCRYPTION_KEY), iv);
    let encrypted = cipher.update(key, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
  } catch (error) {
    console.error('Error encrypting key:', error);
    throw error;
  }
}

// Function to decrypt the private key
function decryptKey(encryptedKey) {
  try {
    const [iv, encrypted] = encryptedKey.split(':');
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(process.env.ENCRYPTION_KEY), Buffer.from(iv, 'hex'));
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (error) {
    console.error('Error decrypting key:', error);
    throw error;
  }
}

// Function to get the agent's private key
function getAgentPrivateKey(chatId) {
  try {
    const { encryptedKey } = retrieveAgentKeyFromStorage(chatId);
    return decryptKey(encryptedKey);
  } catch (error) {
    console.error(`Error getting agent private key for user ${chatId}:`, error);
    throw error;
  }
}

// Telegram Bot Commands with Keyboard Markup
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    await initializeStorage();
    const keyboard = [
      ['/predict', '/insights'],
      ['/bot_stats', '/manage_portfolio'],
      ['/trade_history', '/settings']
    ];
    bot.sendMessage(chatId, 'Welcome to the Crypto Trading Bot! Use these commands to interact:', {
      reply_markup: {
        keyboard: keyboard,
        resize_keyboard: true,
        one_time_keyboard: false
      }
    });
  } catch (error) {
    console.error('Error in /start command:', error);
    bot.sendMessage(chatId, 'An error occurred while initializing the bot. Please try again later.');
  }
});

// Predict Command
bot.onText(/\/predict (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const asset = match[1].toUpperCase();
  try {
    if (!assets.includes(asset)) {
      bot.sendMessage(chatId, `Sorry, ${asset} is not supported. Please choose from: ${assets.join(', ')}.`);
      return;
    }
    const sentimentScore = await fetchAndAnalyzeTweets(`#${asset}`);
    const price = await fetchPriceData(asset);

    if (sentimentScore !== null && price !== null) {
      const sentimentPercentage = convertSentimentScoreToPercentage(sentimentScore);
      const pnlCard = mapToPNLCardScale(sentimentPercentage);
      
      let action = 'hold';
      const user = userData.get(chatId);
      if (user?.thresholds) {
        const buyThresholdPercentage = convertSentimentScoreToPercentage(user.thresholds.buy);
        const sellThresholdPercentage = convertSentimentScoreToPercentage(user.thresholds.sell);
        if (sentimentPercentage >= buyThresholdPercentage) action = 'buy';
        else if (sentimentPercentage <= sellThresholdPercentage) action = 'sell';
      } else {
        action = sentimentScore > 0 ? 'buy' : (sentimentScore < 0 ? 'sell' : 'hold');
      }
      
      bot.sendMessage(chatId, `Current sentiment score for ${asset}: ${sentimentPercentage.toFixed(2)}% which corresponds to **PNL Card #${pnlCard}**. Current price: $${price}. I would ${action}.`);
      
      // Path to the PNL card image
      const imagePath = path.join(__dirname, 'pnl_cards', `${pnlCard}.png`);
      
      // Check if the file exists
      fs.access(imagePath, fs.constants.F_OK, (err) => {
        if (err) {
          console.error(`PNL Card image for #${pnlCard} not found:`, err);
          bot.sendMessage(chatId, `Sorry, the PNL Card image for #${pnlCard} is not available.`);
        } else {
          // Send the PNL card image
          bot.sendPhoto(chatId, imagePath, {}, {
            caption: `Here is your PNL Card for ${asset}`
          });
        }
      });
    } else {
      bot.sendMessage(chatId, 'Error fetching market sentiment or price data.');
    }
  } catch (error) {
    console.error('Error in predict command:', error);
    bot.sendMessage(chatId, 'An error occurred while processing your request.');
  }
});

// Insights Command
bot.onText(/\/insights (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const asset = match[1].toUpperCase();
  try {
    if (!assets.includes(asset)) {
      bot.sendMessage(chatId, `Sorry, ${asset} is not supported. Please choose from: ${assets.join(', ')}.`);
      return;
    }
    const sentimentScore = await fetchAndAnalyzeTweets(`#${asset}`);
    const currentPrice = await fetchPriceData(asset);
    const user = userData.get(chatId);
    const buyPrice = user?.portfolio?.[asset]?.buyPrice || currentPrice;

    if (sentimentScore !== null && currentPrice !== null) {
      const fileId = await storeSentimentData(asset, sentimentScore);
      bot.sendMessage(chatId, `Current Market Sentiment for ${asset}:\nIPFS Link: https://${process.env.PINATA_GATEWAY}/ipfs/${fileId}`);
      
      // Execute trade based on sentiment and price
      await executeTrade(sentimentScore, asset, currentPrice, buyPrice, chatId);
    } else {
      bot.sendMessage(chatId, 'An error occurred while fetching market sentiment or price data.');
    }
  } catch (error) {
    console.error('Error in insights command:', error);
    bot.sendMessage(chatId, 'An error occurred while processing your request.');
  }
});

// Bot Stats Command
bot.onText(/\/bot_stats/, (msg) => {
  const chatId = msg.chat.id;
  try {
    const stats = getBotStats();
    const totalPNL = calculateTotalPNL(chatId);
    const message = `Bot Uptime: ${stats.uptime} hours\nTrades Executed: ${stats.tradesExecuted}\nSentiment Analysis Accuracy: ${stats.sentimentAccuracy}%\nTotal PNL: ${totalPNL}\nLast Update: ${stats.lastUpdate}`;
    bot.sendMessage(chatId, message);
  } catch (error) {
    console.error('Error in bot_stats command:', error);
    bot.sendMessage(chatId, 'An error occurred while retrieving bot statistics.');
  }
});

// Manage Portfolio Command
bot.onText(/\/manage_portfolio/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const user = userData.get(chatId);
    if (!user || !user.portfolio) {
      bot.sendMessage(chatId, 'You have no portfolio to manage yet. Use /insights to start trading.');
      return;
    }
    
    const sentimentData = {};
    for (let asset of Object.keys(user.portfolio)) {
      sentimentData[asset] = await fetchAndAnalyzeTweets(`#${asset}`);
    }
    const updatedPortfolio = await managePortfolio(chatId, sentimentData);
    bot.sendMessage(chatId, `Your updated portfolio based on current sentiment:\n${JSON.stringify(updatedPortfolio, null, 2)}`);
  } catch (error) {
    console.error('Error in manage_portfolio command:', error);
    bot.sendMessage(chatId, 'An error occurred while managing your portfolio.');
  }
});

// Trade History Command
bot.onText(/\/trade_history/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const user = userData.get(chatId);
    if (user && user.tradeHistory && user.tradeHistory.length > 0) {
      let historyMessage = '```\n';
      historyMessage += 'Currency\tPNL\tStatus\tID\tTimeframe\tTimestamp\tEntry Price\tExit Price\n';
      user.tradeHistory.forEach(trade => {
        historyMessage += `${trade.currency}\t${trade.pnl}\t${trade.status}\t${trade.id}\t${trade.timeframe}\t${trade.timestamp}\t$${trade.entryPrice}\t$${trade.exitPrice}\n`;
      });
      historyMessage += '```';
      bot.sendMessage(chatId, `Your trade history:\n${historyMessage}`, { parse_mode: 'Markdown' });
    } else {
      bot.sendMessage(chatId, 'You have no trade history yet.');
    }
  } catch (error) {
    console.error('Error in trade_history command:', error);
    bot.sendMessage(chatId, 'An error occurred while fetching your trade history.');
  }
});

// Settings Command - Inline Menu
bot.onText(/\/settings/, (msg) => {
  const chatId = msg.chat.id;
  try {
    const inlineKeyboard = [
      [{ text: 'Set Thresholds', callback_data: 'set_thresholds' }],
      [{ text: 'Set Profit Threshold', callback_data: 'set_profit_threshold' }],
      [{ text: 'Set Stop-Loss', callback_data: 'set_stop_loss' }],
      [{ text: 'Set Risk', callback_data: 'set_risk' }],
      [{ text: 'Change Language', callback_data: 'change_language' }],
      [{ text: 'News', callback_data: 'news' }]
    ];
    bot.sendMessage(chatId, 'Choose a setting to adjust:', {
      reply_markup: {
        inline_keyboard: inlineKeyboard
      }
    });
  } catch (error) {
    console.error('Error in settings command:', error);
    bot.sendMessage(chatId, 'An error occurred while displaying settings.');
  }
});

// Handling callback queries for settings
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  try {
    switch (query.data) {
      case 'set_thresholds':
        bot.sendMessage(chatId, 'Please provide buy and sell thresholds as /set_threshold buy_threshold sell_threshold. Example: /set_threshold 1.5 -1.5');
        break;
      case 'set_profit_threshold':
        bot.sendMessage(chatId, 'Please provide your profit threshold as /set_profit_threshold percentage. Example: /set_profit_threshold 20');
        break;
      case 'set_stop_loss':
        bot.sendMessage(chatId, 'Please provide your stop-loss threshold as /set_stop_loss percentage. Example: /set_stop_loss 10');
        break;
      case 'set_risk':
        bot.sendMessage(chatId, 'Please provide your risk percentage as /set_risk percentage. Example: /set_risk 5');
        break;
      case 'change_language':
        const languageKeyboard = Object.keys(languages).map(lang => [{ text: languages[lang], callback_data: `lang_${lang}` }]);
        bot.sendMessage(chatId, 'Select your preferred language:', {
          reply_markup: {
            inline_keyboard: languageKeyboard
          }
        });
        break;
      case 'news':
        bot.sendMessage(chatId, 'Please provide an asset to get news about as /news asset. Example: /news BTC');
        break;
      default:
        if (query.data.startsWith('lang_')) {
          const lang = query.data.split('_')[1];
          if (!userData.has(chatId)) userData.set(chatId, {});
          userData.get(chatId).language = lang;
          bot.answerCallbackQuery(query.id);
          bot.sendMessage(chatId, `Language set to ${languages[lang]}`);
        }
    }
  } catch (error) {
    console.error('Error handling callback query:', error);
    bot.answerCallbackQuery(query.id, { text: 'An error occurred.', show_alert: true });
  }
});

// Set Thresholds Command
bot.onText(/\/set_threshold (.+) (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const buyThreshold = parseFloat(match[1]);
  const sellThreshold = parseFloat(match[2]);

  try {
    if (!isNaN(buyThreshold) && !isNaN(sellThreshold)) {
      if (!userData.has(chatId)) userData.set(chatId, {});
      userData.get(chatId).thresholds = { buy: buyThreshold, sell: sellThreshold };
      bot.sendMessage(chatId, `Your sentiment thresholds have been set to Buy: ${buyThreshold}, Sell: ${sellThreshold}.`);
    } else {
      bot.sendMessage(chatId, 'Please provide valid numbers for buy and sell thresholds.');
    }
  } catch (error) {
    console.error('Error in set_threshold command:', error);
    bot.sendMessage(chatId, 'An error occurred while setting thresholds.');
  }
});

// Set Profit Threshold Command
bot.onText(/\/set_profit_threshold (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const profitThreshold = parseFloat(match[1]);

  try {
    if (!isNaN(profitThreshold)) {
      if (!userData.has(chatId)) userData.set(chatId, {});
      userData.get(chatId).profitThreshold = profitThreshold;
      bot.sendMessage(chatId, `Your profit threshold has been set to ${profitThreshold}%.`);
    } else {
      bot.sendMessage(chatId, 'Please provide a valid number for the profit threshold.');
    }
  } catch (error) {
    console.error('Error in set_profit_threshold command:', error);
    bot.sendMessage(chatId, 'An error occurred while setting profit threshold.');
  }
});

// Set Stop-Loss Command
bot.onText(/\/set_stop_loss (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const stopLossPercentage = parseFloat(match[1]);

  try {
    if (!isNaN(stopLossPercentage)) {
      if (!userData.has(chatId)) userData.set(chatId, {});
      userData.get(chatId).stopLossThreshold = stopLossPercentage;
      bot.sendMessage(chatId, `Your stop-loss threshold has been set to ${stopLossPercentage}%.`);
    } else {
      bot.sendMessage(chatId, 'Please provide a valid number for the stop-loss threshold.');
    }
  } catch (error) {
    console.error('Error in set_stop_loss command:', error);
    bot.sendMessage(chatId, 'An error occurred while setting stop-loss threshold.');
  }
});

// Set Risk Command
bot.onText(/\/set_risk (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const riskPercentage = parseFloat(match[1]);

  try {
    if (!isNaN(riskPercentage)) {
      if (!userData.has(chatId)) userData.set(chatId, {});
      userData.get(chatId).riskPercentage = riskPercentage;
      bot.sendMessage(chatId, `Risk percentage set to ${riskPercentage}%.`);
    } else {
      bot.sendMessage(chatId, 'Please provide a valid number for risk percentage.');
    }
  } catch (error) {
    console.error('Error in set_risk command:', error);
    bot.sendMessage(chatId, 'An error occurred while setting risk.');
  }
});

// Fetch News Command
async function fetchNews(asset) {
  try {
    const news = await newsapi.v2.everything({
      q: asset,
      language: 'en',
      sortBy: 'publishedAt',
      pageSize: 5
    });
    return news.articles;
  } catch (error) {
    console.error('Error fetching news:', error);
    throw error;
  }
}

bot.onText(/\/news (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const asset = match[1].toUpperCase();
  try {
    if (!assets.includes(asset)) {
      bot.sendMessage(chatId, `Sorry, ${asset} is not supported. Please choose from: ${assets.join(', ')}.`);
      return;
    }
    const articles = await fetchNews(asset);
    if (articles && articles.length > 0) {
      let newsMessage = `Here are the latest news articles related to ${asset}:\n\n`;
      articles.forEach((article, index) => {
        newsMessage += `${index + 1}. [${article.title}](${article.url})\nPublished by ${article.source.name} on ${new Date(article.publishedAt).toLocaleDateString()}\n\n`;
      });
      bot.sendMessage(chatId, newsMessage, { parse_mode: 'Markdown' });
    } else {
      bot.sendMessage(chatId, `No recent news found for ${asset}.`);
    }
  } catch (error) {
    console.error('Error fetching news:', error);
    bot.sendMessage(chatId, 'An error occurred while fetching news.');
  }
});

// Error Handling for Bot Operations
bot.on('polling_error', (error) => {
  console.error('Polling error:', error);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  // Here you might want to notify admins or log errors to a service
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Similar to uncaught exceptions, you might want to handle this
});

// Webhook or API endpoint for monitoring or external interactions
app.post('/updateBotStats', (req, res) => {
  try {
    // Example endpoint to update bot stats from external sources
    if (req.body.tradesExecuted) {
      botStats.tradesExecuted = req.body.tradesExecuted;
      botStats.lastUpdate = new Date();
      res.status(200).send('Bot stats updated successfully');
    } else {
      res.status(400).send('Invalid request: No tradesExecuted provided');
    }
  } catch (error) {
    console.error('Error updating bot stats:', error);
    res.status(500).send('An error occurred while updating bot stats');
  }
});

// Start the Express server for potential webhooks or API endpoints
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

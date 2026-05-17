const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const ENV_FILE = path.join(ROOT, ".env");

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  return Object.fromEntries(
    fs
      .readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      })
  );
}

function writeEnv(values) {
  const ordered = [
    "PORT",
    "PUBLIC_BASE_URL",
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_PARENT_CHAT_IDS",
    "TELEGRAM_NOTIFY_CHAT_IDS",
    "APPROVAL_SECRET",
    "DEFAULT_KM_RATE",
    "HOME_ADDRESS",
    "SEARCH_RADIUS_KM"
  ];
  const lines = ordered.map((key) => `${key}=${values[key] || ""}`);
  fs.writeFileSync(ENV_FILE, `${lines.join("\n")}\n`);
}

async function telegram(method, token, payload) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: payload ? "POST" : "GET",
    headers: payload ? { "Content-Type": "application/json" } : undefined,
    body: payload ? JSON.stringify(payload) : undefined
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) {
    throw new Error(body.description || `Telegram ${method} failed`);
  }
  return body.result;
}

async function main() {
  const args = process.argv.slice(2);
  const env = {
    PORT: "3000",
    PUBLIC_BASE_URL: "http://localhost:3000",
    TELEGRAM_BOT_TOKEN: "",
    TELEGRAM_PARENT_CHAT_IDS: "",
    TELEGRAM_NOTIFY_CHAT_IDS: "",
    APPROVAL_SECRET: crypto.randomBytes(24).toString("hex"),
    DEFAULT_KM_RATE: "1.5",
    HOME_ADDRESS: "Havesvinget 14, 2950 Vedbæk",
    SEARCH_RADIUS_KM: "85",
    ...loadEnvFile(ENV_FILE)
  };

  if (!env.APPROVAL_SECRET || env.APPROVAL_SECRET.startsWith("change-this")) {
    env.APPROVAL_SECRET = crypto.randomBytes(24).toString("hex");
  }

  const tokenArgIndex = args.indexOf("--token");
  if (tokenArgIndex >= 0 && args[tokenArgIndex + 1]) {
    env.TELEGRAM_BOT_TOKEN = args[tokenArgIndex + 1];
    writeEnv(env);
    console.log("Saved bot token to .env");
  }

  if (!env.TELEGRAM_BOT_TOKEN) {
    writeEnv(env);
    console.log("Created .env. Add TELEGRAM_BOT_TOKEN, then run this again.");
    process.exit(0);
  }

  const bot = await telegram("getMe", env.TELEGRAM_BOT_TOKEN);
  console.log(`Connected to bot: @${bot.username}`);
  const notifyMode = args.includes("--notify");
  console.log(`Ask ${notifyMode ? "your account" : "your dad"} to open that bot in Telegram and send: /start`);

  const updates = await telegram("getUpdates", env.TELEGRAM_BOT_TOKEN);
  const chats = new Map();
  for (const update of updates) {
    const message = update.message || update.edited_message;
    if (!message?.chat?.id) continue;
    const name = [message.chat.first_name, message.chat.last_name].filter(Boolean).join(" ");
    chats.set(String(message.chat.id), name || message.chat.username || message.chat.type);
  }

  if (chats.size === 0) {
    console.log(`No chats found yet. Wait until ${notifyMode ? "you send" : "your dad sends"} /start, then run:`);
    console.log(`node scripts/telegram-setup.js${notifyMode ? " --notify" : ""}`);
    return;
  }

  const [chatId, name] = [...chats.entries()][chats.size - 1];
  if (notifyMode) {
    env.TELEGRAM_NOTIFY_CHAT_IDS = chatId;
  } else {
    env.TELEGRAM_PARENT_CHAT_IDS = chatId;
  }
  writeEnv(env);
  console.log(`Saved ${notifyMode ? "notification" : "dad's"} chat ID to .env: ${chatId}${name ? ` (${name})` : ""}`);

  await telegram("sendMessage", env.TELEGRAM_BOT_TOKEN, {
    chat_id: chatId,
    text: notifyMode
      ? "FamilyCarSharing will send you approval and denial messages here."
      : "Car sharing app is connected. Booking requests will arrive here."
  });
  console.log("Sent a test message to Telegram.");
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

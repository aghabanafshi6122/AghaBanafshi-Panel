/**
 * سرور اصلی پنل مدیریت «PURPLE» (Purple VPN Panel)
 * طراحی شده برای استقرار روی Railway (مبتنی بر Docker)
 * زبان: فارسی (RTL)
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { spawn } = require('child_process');
const http = require('http');
const https = require('https');
const net = require('net');

const app = express();
const PORT = process.env.PORT || 8080;

// مسیر ذخیره‌سازی داده‌ها برای Docker Volume
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync('/app/data') ? '/app/data' : path.join(__dirname, 'data'));
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const SINGBOX_CONFIG_FILE = path.join(DATA_DIR, 'singbox_config.json');

// پیکربندی پیش‌فرض پنل
const defaultSettings = {
  isConfigured: false,
  username: '',
  password: '',
  jwtSecret: 'purple_secret_' + Math.random().toString(36).substring(2),
  vlessPort: 8443,
  serviceName: 'vless-grpc',
  trojanPassword: 'purple_trojan_pass_' + Math.random().toString(36).substring(2, 8),
  cleanIp: '',
  enableVlessWs: true,
  enableVlessGrpc: true,
  enableTrojanWs: true,
  telegramBotToken: '',
  telegramAdminId: ''
};

// دریافت یا ایجاد فایل تنظیمات
function getSettings() {
  if (!fs.existsSync(SETTINGS_FILE)) {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(defaultSettings, null, 2), 'utf-8');
    return defaultSettings;
  }
  try {
    const data = fs.readFileSync(SETTINGS_FILE, 'utf-8');
    return { ...defaultSettings, ...JSON.parse(data) };
  } catch (e) {
    return defaultSettings;
  }
}

function saveSettings(newSettings) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(newSettings, null, 2), 'utf-8');
}

// دریافت یا ایجاد فایل کاربران
function getUsers() {
  if (!fs.existsSync(USERS_FILE)) {
    fs.writeFileSync(USERS_FILE, JSON.stringify([], null, 2), 'utf-8');
    return [];
  }
  try {
    const data = fs.readFileSync(USERS_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (e) {
    return [];
  }
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf-8');
  rebuildSingboxConfig();
}

// لیست آی‌پی‌های تمیز پیشنهادی
const PRESET_CLEAN_IPS = [
  { ip: '162.159.192.1', name: 'Cloudflare Clean IP #1', latency: 'مناسب IR' },
  { ip: '162.159.193.1', name: 'Cloudflare Clean IP #2', latency: 'مناسب همراه اول' },
  { ip: '104.16.132.229', name: 'Cloudflare Clean IP #3', latency: 'مناسب ایرانسل' },
  { ip: '104.17.147.22', name: 'Cloudflare Clean IP #4', latency: 'مناسب رایتل / شاتل' },
  { ip: '172.67.182.10', name: 'Cloudflare Clean IP #5', latency: 'پایدار و پرسرعت' }
];

// مدیریت پروسه Sing-box
let singboxProcess = null;

function rebuildSingboxConfig() {
  const settings = getSettings();
  const users = getUsers();

  const today = new Date().toISOString().split('T')[0];
  const activeUsers = users.filter(u => {
    if (u.status !== 'active') return false;
    if (u.expireDate && u.expireDate < today) return false;
    if (u.limitBytes > 0 && u.usedBytes >= u.limitBytes) return false;
    return true;
  });

  const serviceName = settings.serviceName || "vless-grpc";
  const trojanPass = settings.trojanPassword || "purple_trojan_pass";

  const singboxConfig = {
    log: {
      level: "info",
      timestamp: true
    },
    inbounds: [
      {
        type: "vless",
        tag: "vless-ws-inbound",
        listen: "127.0.0.1",
        listen_port: 2083,
        users: activeUsers.map(u => ({
          name: u.name,
          uuid: u.uuid
        })),
        transport: {
          type: "ws",
          path: "/vless"
        }
      },
      {
        type: "vless",
        tag: "vless-grpc-inbound",
        listen: "127.0.0.1",
        listen_port: 2084,
        users: activeUsers.map(u => ({
          name: u.name,
          uuid: u.uuid
        })),
        transport: {
          type: "grpc",
          service_name: serviceName
        }
      },
      {
        type: "trojan",
        tag: "trojan-ws-inbound",
        listen: "127.0.0.1",
        listen_port: 2085,
        users: [
          {
            name: "purple-trojan-user",
            password: trojanPass
          }
        ],
        transport: {
          type: "ws",
          path: "/trojan"
        }
      }
    ],
    outbounds: [
      {
        type: "direct",
        tag: "direct"
      },
      {
        type: "block",
        tag: "block"
      }
    ]
  };

  fs.writeFileSync(SINGBOX_CONFIG_FILE, JSON.stringify(singboxConfig, null, 2), 'utf-8');
  restartSingboxProcess();
}

// ---- سیستم ربات تلگرام تعاملی ----

let lastTelegramUpdateId = 0;
let telegramPollingTimeout = null;
const botStateMap = {};

function sendTelegramMessage(text, replyMarkup = null, customChatId = null) {
  const settings = getSettings();
  if (!settings.telegramBotToken) return;

  const chatId = customChatId || settings.telegramAdminId;
  if (!chatId) return;

  const payload = {
    chat_id: chatId,
    text: text,
    parse_mode: 'HTML'
  };

  if (replyMarkup) {
    payload.reply_markup = replyMarkup;
  }

  const data = JSON.stringify(payload);
  const req = https.request({
    hostname: 'api.telegram.org',
    path: `/bot${settings.telegramBotToken}/sendMessage`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data)
    }
  }, (res) => {});

  req.on('error', () => {});
  req.write(data);
  req.end();
}

function answerCallbackQuery(callbackQueryId, text = '') {
  const settings = getSettings();
  if (!settings.telegramBotToken) return;

  const data = JSON.stringify({
    callback_query_id: callbackQueryId,
    text: text
  });

  const req = https.request({
    hostname: 'api.telegram.org',
    path: `/bot${settings.telegramBotToken}/answerCallbackQuery`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data)
    }
  }, (res) => {});

  req.on('error', () => {});
  req.write(data);
  req.end();
}

function getTelegramMainMenuKeyboard() {
  return {
    keyboard: [
      [{ text: '📊 آمار سرور' }, { text: '👥 مدیریت و لیست کاربران' }],
      [{ text: '➕ ساخت کاربر جدید (ویزارد)' }, { text: '🔍 استعلام سریع' }]
    ],
    resize_keyboard: true,
    persistent: true
  };
}

function initTelegramBot() {
  if (telegramPollingTimeout) clearTimeout(telegramPollingTimeout);

  const settings = getSettings();
  if (!settings.telegramBotToken) {
    telegramPollingTimeout = setTimeout(initTelegramBot, 10000);
    return;
  }

  const req = https.request({
    hostname: 'api.telegram.org',
    path: `/bot${settings.telegramBotToken}/getUpdates?offset=${lastTelegramUpdateId + 1}&timeout=15`,
    method: 'GET'
  }, (res) => {
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (data.ok && Array.isArray(data.result)) {
          for (const update of data.result) {
            lastTelegramUpdateId = update.update_id;
            handleTelegramUpdate(update);
          }
        }
      } catch (e) {}
      telegramPollingTimeout = setTimeout(initTelegramBot, 1500);
    });
  });

  req.on('error', () => {
    telegramPollingTimeout = setTimeout(initTelegramBot, 5000);
  });
  req.end();
}

function handleTelegramUpdate(update) {
  const settings = getSettings();

  if (update.callback_query) {
    const cb = update.callback_query;
    const chatId = cb.message.chat.id;
    const data = cb.data;

    if (settings.telegramAdminId && chatId.toString() !== settings.telegramAdminId.toString()) {
      answerCallbackQuery(cb.id, '⛔ دسترسی غیرمجاز.');
      return;
    }

    answerCallbackQuery(cb.id);

    if (data.startsWith('c_limit_')) {
      const limitGB = parseFloat(data.replace('c_limit_', ''));
      if (!botStateMap[chatId]) botStateMap[chatId] = {};
      botStateMap[chatId].limitGB = limitGB;
      botStateMap[chatId].step = 'await_days';

      const daysMarkup = {
        inline_keyboard: [
          [{ text: '7 روز', callback_data: 'c_days_7' }, { text: '30 روز', callback_data: 'c_days_30' }],
          [{ text: '60 روز', callback_data: 'c_days_60' }, { text: '90 روز', callback_data: 'c_days_90' }],
          [{ text: '♾️ نامحدود', callback_data: 'c_days_0' }]
        ]
      };

      sendTelegramMessage(
        `⏳ <b>مرحله ۳ از ۳: تعیین مدت زمان اعتبار</b>\n\n` +
        `نام: <b>${botStateMap[chatId].name}</b>\n` +
        `حجم: <b>${limitGB > 0 ? limitGB + ' GB' : 'نامحدود'}</b>\n\n` +
        `لطفاً مدت اعتبار را انتخاب کنید یا عدد تایپ نمایید:`,
        daysMarkup,
        chatId
      );
      return;
    }

    if (data.startsWith('c_days_')) {
      const expireDays = parseInt(data.replace('c_days_', ''));
      const state = botStateMap[chatId] || {};
      const name = state.name || 'کاربر جدید';
      const limitGB = state.limitGB || 0;

      delete botStateMap[chatId];

      const users = getUsers();
      let expireDate = null;
      if (expireDays > 0) {
        const d = new Date();
        d.setDate(d.getDate() + expireDays);
        expireDate = d.toISOString().split('T')[0];
      }

      const newUser = {
        id: uuidv4(),
        name: name.trim(),
        uuid: uuidv4(),
        limitBytes: limitGB * 1024 * 1024 * 1024,
        usedBytes: 0,
        expireDate: expireDate,
        status: 'active',
        createdAt: new Date().toISOString()
      };

      users.push(newUser);
      saveUsers(users);

      const host = settings.cleanIp || 'سرور';
      const subUrl = `http://${host}/sub/${newUser.uuid}`;

      sendTelegramMessage(
        `🎉 <b>کاربر با موفقیت ایجاد شد!</b>\n\n` +
        `👤 <b>نام:</b> ${newUser.name}\n` +
        `📊 <b>حجم:</b> ${limitGB > 0 ? limitGB + ' GB' : 'نامحدود'}\n` +
        `⏳ <b>اعتبار:</b> ${expireDays > 0 ? expireDays + ' روز' : 'نامحدود'}\n\n` +
        `🔑 <b>UUID:</b> <code>${newUser.uuid}</code>\n\n` +
        `🔗 <b>لینک سابسکریپشن:</b>\n<code>${subUrl}</code>`,
        getTelegramMainMenuKeyboard(),
        chatId
      );
      return;
    }

    if (data.startsWith('u_det_')) {
      const userId = data.replace('u_det_', '');
      sendUserManagementCard(userId, chatId);
      return;
    }

    if (data.startsWith('u_sub_')) {
      const userId = data.replace('u_sub_', '');
      const users = getUsers();
      const user = users.find(u => u.id === userId || u.uuid === userId);
      if (user) {
        const subUrl = `http://${settings.cleanIp || 'سرور'}/sub/${user.uuid}`;
        sendTelegramMessage(
          `🔗 <b>لینک سابسکریپشن کاربر ${user.name}:</b>\n\n` +
          `<code>${subUrl}</code>`,
          null,
          chatId
        );
      }
      return;
    }

    if (data.startsWith('u_reset_')) {
      const userId = data.replace('u_reset_', '');
      const users = getUsers();
      const user = users.find(u => u.id === userId || u.uuid === userId);
      if (user) {
        user.usedBytes = 0;
        saveUsers(users);
        sendTelegramMessage(`🔄 ترافیک مصرفی کاربر <b>${user.name}</b> صفر گردید.`, null, chatId);
        sendUserManagementCard(user.id, chatId);
      }
      return;
    }

    if (data.startsWith('u_toggle_')) {
      const userId = data.replace('u_toggle_', '');
      const users = getUsers();
      const user = users.find(u => u.id === userId || u.uuid === userId);
      if (user) {
        user.status = user.status === 'active' ? 'disabled' : 'active';
        saveUsers(users);
        sendTelegramMessage(`وضعیت کاربر <b>${user.name}</b> به <b>${user.status === 'active' ? 'فعال' : 'غیرفعال'}</b> تغییر یافت.`, null, chatId);
        sendUserManagementCard(user.id, chatId);
      }
      return;
    }

    if (data.startsWith('u_del_')) {
      const userId = data.replace('u_del_', '');
      const users = getUsers();
      const index = users.findIndex(u => u.id === userId || u.uuid === userId);
      if (index !== -1) {
        const userName = users[index].name;
        users.splice(index, 1);
        saveUsers(users);
        sendTelegramMessage(`🗑️ کاربر <b>${userName}</b> با موفقیت حذف گردید.`, getTelegramMainMenuKeyboard(), chatId);
      }
      return;
    }
  }

  if (!update.message || !update.message.text) return;

  const msg = update.message;
  const chatId = msg.chat.id;
  const text = msg.text.trim();

  if (settings.telegramAdminId && chatId.toString() !== settings.telegramAdminId.toString()) {
    sendTelegramMessage('⛔ دسترسی غیرمجاز. این ربات تنها برای مدیریت سرور تنظیم شده است.', null, chatId);
    return;
  }

  if (botStateMap[chatId]) {
    const state = botStateMap[chatId];

    if (state.step === 'await_name') {
      state.name = text;
      state.step = 'await_limit';

      const limitMarkup = {
        inline_keyboard: [
          [{ text: '10 GB', callback_data: 'c_limit_10' }, { text: '30 GB', callback_data: 'c_limit_30' }],
          [{ text: '50 GB', callback_data: 'c_limit_50' }, { text: '100 GB', callback_data: 'c_limit_100' }],
          [{ text: '♾️ نامحدود', callback_data: 'c_limit_0' }]
        ]
      };

      sendTelegramMessage(
        `📊 <b>مرحله ۲ از ۳: تعیین حجم مجاز (GB)</b>\n\n` +
        `نام کاربر: <b>${text}</b>\n\n` +
        `لطفاً یکی از حجم‌های زیر را انتخاب کنید یا عدد تایپ کنید:`,
        limitMarkup,
        chatId
      );
      return;
    }

    if (state.step === 'await_limit') {
      const limitGB = parseFloat(text) || 0;
      state.limitGB = limitGB;
      state.step = 'await_days';

      const daysMarkup = {
        inline_keyboard: [
          [{ text: '7 روز', callback_data: 'c_days_7' }, { text: '30 روز', callback_data: 'c_days_30' }],
          [{ text: '60 روز', callback_data: 'c_days_60' }, { text: '90 روز', callback_data: 'c_days_90' }],
          [{ text: '♾️ نامحدود', callback_data: 'c_days_0' }]
        ]
      };

      sendTelegramMessage(
        `⏳ <b>مرحله ۳ از ۳: تعیین مدت زمان اعتبار (روز)</b>\n\n` +
        `نام: <b>${state.name}</b> | حجم: <b>${limitGB > 0 ? limitGB + ' GB' : 'نامحدود'}</b>\n\n` +
        `لطفاً مدت اعتبار را انتخاب کنید یا عدد تایپ نمایید:`,
        daysMarkup,
        chatId
      );
      return;
    }

    if (state.step === 'await_days') {
      const expireDays = parseInt(text) || 0;
      const name = state.name || 'کاربر جدید';
      const limitGB = state.limitGB || 0;

      delete botStateMap[chatId];

      const users = getUsers();
      let expireDate = null;
      if (expireDays > 0) {
        const d = new Date();
        d.setDate(d.getDate() + expireDays);
        expireDate = d.toISOString().split('T')[0];
      }

      const newUser = {
        id: uuidv4(),
        name: name.trim(),
        uuid: uuidv4(),
        limitBytes: limitGB * 1024 * 1024 * 1024,
        usedBytes: 0,
        expireDate: expireDate,
        status: 'active',
        createdAt: new Date().toISOString()
      };

      users.push(newUser);
      saveUsers(users);

      const host = settings.cleanIp || 'سرور';
      const subUrl = `http://${host}/sub/${newUser.uuid}`;

      sendTelegramMessage(
        `🎉 <b>کاربر با موفقیت ایجاد شد!</b>\n\n` +
        `👤 <b>نام:</b> ${newUser.name}\n` +
        `📊 <b>حجم:</b> ${limitGB > 0 ? limitGB + ' GB' : 'نامحدود'}\n` +
        `⏳ <b>اعتبار:</b> ${expireDays > 0 ? expireDays + ' روز' : 'نامحدود'}\n\n` +
        `🔑 <b>UUID:</b> <code>${newUser.uuid}</code>\n\n` +
        `🔗 <b>لینک سابسکریپشن:</b>\n<code>${subUrl}</code>`,
        getTelegramMainMenuKeyboard(),
        chatId
      );
      return;
    }
  }

  if (text === '/start' || text === 'منو' || text === 'menu') {
    delete botStateMap[chatId];
    sendTelegramMessage(
      `⚡ <b>به ربات مدیریتی «PURPLE» خوش آمدید!</b>\n\nلطفاً یکی از گزینه‌های زیر را انتخاب کنید:`,
      getTelegramMainMenuKeyboard(),
      chatId
    );
    return;
  }

  if (text === '➕ ساخت کاربر جدید (ویزارد)' || text === '/create') {
    botStateMap[chatId] = { step: 'await_name' };
    sendTelegramMessage(
      `📝 <b>مرحله ۱ از ۳: نام کاربر</b>\n\n` +
      `لطفاً نام کاربر جدید را تایپ و ارسال نمایید:\n` +
      `(مثال: <code>ali_user</code>)`,
      null,
      chatId
    );
    return;
  }

  if (text === '📊 آمار سرور' || text === '/stats') {
    const users = getUsers();
    const today = new Date().toISOString().split('T')[0];

    const totalUsers = users.length;
    const activeUsers = users.filter(u => u.status === 'active' && (!u.expireDate || u.expireDate >= today) && (u.limitBytes === 0 || u.usedBytes < u.limitBytes)).length;
    const expiredUsers = users.filter(u => (u.expireDate && u.expireDate < today) || (u.limitBytes > 0 && u.usedBytes >= u.limitBytes)).length;

    const totalUsedBytes = users.reduce((acc, u) => acc + (u.usedBytes || 0), 0);
    const usedGB = (totalUsedBytes / (1024 * 1024 * 1024)).toFixed(2);

    sendTelegramMessage(
      `📊 <b>آمار کلی پنل PURPLE:</b>\n\n` +
      `👥 <b>کل کاربران:</b> ${totalUsers} نفر\n` +
      `✅ <b>کاربران فعال:</b> ${activeUsers} نفر\n` +
      `❌ <b>کاربران منقضی:</b> ${expiredUsers} نفر\n` +
      `🌐 <b>کل ترافیک مصرفی:</b> ${usedGB} GB`,
      getTelegramMainMenuKeyboard(),
      chatId
    );
    return;
  }

  if (text === '👥 مدیریت و لیست کاربران' || text === '/users') {
    sendUsersInlineList(chatId);
    return;
  }

  if (text === '🔍 استعلام سریع') {
    sendUsersInlineList(chatId);
    return;
  }
}

function sendUsersInlineList(chatId) {
  const users = getUsers();
  if (users.length === 0) {
    sendTelegramMessage('ℹ️ هیچ کاربری در پنل ثبت نشده است.', getTelegramMainMenuKeyboard(), chatId);
    return;
  }

  const inlineKeyboard = [];
  users.forEach((u) => {
    const usedGB = (u.usedBytes / (1024 * 1024 * 1024)).toFixed(1);
    const limitGB = u.limitBytes > 0 ? (u.limitBytes / (1024 * 1024 * 1024)).toFixed(0) + 'GB' : '♾️';
    inlineKeyboard.push([{
      text: `👤 ${u.name} | 📊 ${usedGB}/${limitGB}`,
      callback_data: `u_det_${u.id}`
    }]);
  });

  sendTelegramMessage(
    `👥 <b>لیست کاربران پنل (${users.length} نفر):</b>\n\n` +
    `برای مدیریت، ویرایش یا دریافت لینک ساب بر روی کاربر کلیک کنید:`,
    { inline_keyboard: inlineKeyboard },
    chatId
  );
}

function sendUserManagementCard(userId, chatId) {
  const users = getUsers();
  const user = users.find(u => u.id === userId || u.uuid === userId);

  if (!user) {
    sendTelegramMessage('❌ کاربر یافت نشد.', getTelegramMainMenuKeyboard(), chatId);
    return;
  }

  const settings = getSettings();
  const usedGB = (user.usedBytes / (1024 * 1024 * 1024)).toFixed(2);
  const limitGB = user.limitBytes > 0 ? (user.limitBytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB' : 'نامحدود';

  let expireText = 'نامحدود';
  if (user.expireDate) {
    const diffDays = Math.ceil((new Date(user.expireDate) - new Date()) / (1024 * 60 * 60 * 24));
    expireText = diffDays > 0 ? `${diffDays} روز باقی‌مانده` : 'منقضی شده';
  }

  const inlineKeyboard = {
    inline_keyboard: [
      [{ text: '🔗 کپی لینک ساب', callback_data: `u_sub_${user.id}` }],
      [
        { text: user.status === 'active' ? '🔴 غیرفعال‌سازی' : '🟢 فعال‌سازی', callback_data: `u_toggle_${user.id}` },
        { text: '🔄 صفر کردن مصرف', callback_data: `u_reset_${user.id}` }
      ],
      [{ text: '🗑️ حذف کامل کاربر', callback_data: `u_del_${user.id}` }],
      [{ text: '🔙 بازگشت به لیست کاربران', callback_data: 'c_days_back' }]
    ]
  };

  sendTelegramMessage(
    `👤 <b>پنل مدیریت کاربر: ${user.name}</b>\n\n` +
    `وضعیت: <b>${user.status === 'active' ? '✅ فعال' : '🔴 غیرفعال'}</b>\n` +
    `📊 <b>حجم مصرفی:</b> ${usedGB} / ${limitGB}\n` +
    `⏳ <b>تاریخ انقضا:</b> ${expireText}\n` +
    `🔑 <b>UUID:</b> <code>${user.uuid}</code>`,
    inlineKeyboard,
    chatId
  );
}

function restartSingboxProcess() {
  if (singboxProcess) {
    try {
      singboxProcess.kill('SIGKILL');
    } catch (e) {}
    singboxProcess = null;
  }

  const singboxBin = process.env.SINGBOX_BIN || '/app/sing-box';
  if (fs.existsSync(singboxBin)) {
    console.log('در حال راه‌اندازی هسته Sing-box PURPLE...');
    singboxProcess = spawn(singboxBin, ['run', '-c', SINGBOX_CONFIG_FILE], {
      stdio: 'inherit'
    });

    singboxProcess.on('error', (err) => {
      console.error('خطا در اجرای Sing-box:', err.message);
    });

    singboxProcess.on('exit', (code) => {
      console.log(`پروسه Sing-box با کد ${code} متوقف شد.`);
    });
  } else {
    console.log('فایل اجرایی Sing-box یافت نشد (محیط توسعه محلی). کانفیگ جدید ذخیره گردید.');
  }
}

// میدل‌ورهای پایه Express
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(cors());

// میدل‌ور پراکسی برای درخواست‌های gRPC
app.use((req, res, next) => {
  const settings = getSettings();
  const isGrpc = (req.headers['content-type'] && req.headers['content-type'].includes('application/grpc')) || 
                 req.url.includes('vless-grpc') || 
                 req.url.includes(settings.serviceName || 'vless-grpc');

  if (isGrpc) {
    const connector = http.request({
      hostname: '127.0.0.1',
      port: 2084,
      path: req.url,
      method: req.method,
      headers: req.headers
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });

    connector.on('error', () => {
      if (!res.headersSent) res.status(502).end();
    });

    req.pipe(connector);
  } else {
    next();
  }
});

// فایل‌های استاتیک
app.use(express.static(path.join(__dirname, 'public')));

// میدل‌ور احراز هویت با JWT
function authMiddleware(req, res, next) {
  const token = req.cookies.token || req.headers.authorization?.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ success: false, message: 'دسترسی غیرمجاز. لطفاً وارد شوید.' });
  }

  const settings = getSettings();
  try {
    const decoded = jwt.verify(token, settings.jwtSecret);
    req.admin = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'توکن نامعتبر است یا منقضی شده.' });
  }
}

// ---- API های سیستم ----

app.get('/api/setup-status', (req, res) => {
  const settings = getSettings();
  res.json({
    success: true,
    isConfigured: !!settings.isConfigured,
    hasUsers: getUsers().length > 0
  });
});

app.post('/api/setup-initial', (req, res) => {
  const { username, password, cleanIp } = req.body;
  const settings = getSettings();

  if (settings.isConfigured) {
    return res.status(400).json({ success: false, message: 'پنل قبلاً پیکربندی شده است.' });
  }

  if (!username || !password || username.trim() === '' || password.trim() === '') {
    return res.status(400).json({ success: false, message: 'نام کاربری و کلمه عبور نمی‌توانند خالی باشند.' });
  }

  settings.username = username.trim();
  settings.password = password.trim();
  if (cleanIp) settings.cleanIp = cleanIp.trim();
  settings.isConfigured = true;

  saveSettings(settings);
  rebuildSingboxConfig();

  const token = jwt.sign({ username: settings.username }, settings.jwtSecret, { expiresIn: '7d' });
  res.cookie('token', token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });

  res.json({
    success: true,
    message: 'راه‌اندازی اولیه «PURPLE» با موفقیت انجام شد.',
    token
  });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const settings = getSettings();

  if (!settings.isConfigured) {
    return res.status(400).json({ success: false, message: 'پنل هنوز راه‌اندازی اولیه نشده است.' });
  }

  if (username === settings.username && password === settings.password) {
    const token = jwt.sign({ username: settings.username }, settings.jwtSecret, { expiresIn: '7d' });
    res.cookie('token', token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });
    return res.json({ success: true, message: 'ورود با موفقیت انجام شد.', token });
  }

  return res.status(400).json({ success: false, message: 'نام کاربری یا کلمه عبور اشتباه است.' });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ success: true, message: 'از سیستم خارج شدید.' });
});

app.get('/api/check-auth', authMiddleware, (req, res) => {
  const settings = getSettings();
  res.json({ success: true, username: settings.username, settings });
});

app.post('/api/change-password', authMiddleware, (req, res) => {
  const { newUsername, newPassword, vlessPort, serviceName, cleanIp, enableVlessWs, enableVlessGrpc, enableTrojanWs, telegramBotToken, telegramAdminId } = req.body;
  const settings = getSettings();

  if (newUsername) settings.username = newUsername.trim();
  if (newPassword) settings.password = newPassword.trim();
  if (vlessPort) settings.vlessPort = parseInt(vlessPort);
  if (serviceName) settings.serviceName = serviceName.trim();
  if (cleanIp !== undefined) settings.cleanIp = cleanIp.trim();

  if (enableVlessWs !== undefined) settings.enableVlessWs = !!enableVlessWs;
  if (enableVlessGrpc !== undefined) settings.enableVlessGrpc = !!enableVlessGrpc;
  if (enableTrojanWs !== undefined) settings.enableTrojanWs = !!enableTrojanWs;

  if (telegramBotToken !== undefined) settings.telegramBotToken = telegramBotToken.trim();
  if (telegramAdminId !== undefined) settings.telegramAdminId = telegramAdminId.trim();

  saveSettings(settings);
  rebuildSingboxConfig();
  initTelegramBot();

  res.json({ success: true, message: 'تنظیمات «PURPLE» با موفقیت به‌روزرسانی شد.' });
});

app.post('/api/set-telegram-webhook', authMiddleware, (req, res) => {
  const { token, adminId } = req.body;
  const settings = getSettings();

  const botToken = (token || settings.telegramBotToken || '').trim();
  const botAdminId = (adminId || settings.telegramAdminId || '').trim();

  if (!botToken) {
    return res.status(400).json({ success: false, message: 'لطفاً ابتدا توکن ربات تلگرام را وارد کنید.' });
  }

  settings.telegramBotToken = botToken;
  if (botAdminId) settings.telegramAdminId = botAdminId;
  saveSettings(settings);

  const deleteReq = https.request({
    hostname: 'api.telegram.org',
    path: `/bot${botToken}/deleteWebhook`,
    method: 'GET'
  }, (telegramRes) => {
    let body = '';
    telegramRes.on('data', chunk => body += chunk);
    telegramRes.on('end', () => {
      initTelegramBot();
      return res.json({
        success: true,
        message: '✅ تنظیمات ربات تلگرام ذخیره شد و ارتباط ربات با موفقیت فعال گردید!\n\nاکنون می‌توانید در تلگرام به ربات خود پیام /start ارسال کنید.'
      });
    });
  });

  deleteReq.on('error', () => {
    initTelegramBot();
    res.json({ success: true, message: 'تنظیمات ذخیره شد.' });
  });
  deleteReq.end();
});

app.get('/api/stats', authMiddleware, (req, res) => {
  const users = getUsers();
  const today = new Date().toISOString().split('T')[0];

  const totalUsers = users.length;
  const activeUsers = users.filter(u => u.status === 'active' && (!u.expireDate || u.expireDate >= today) && (u.limitBytes === 0 || u.usedBytes < u.limitBytes)).length;
  const expiredUsers = users.filter(u => (u.expireDate && u.expireDate < today) || (u.limitBytes > 0 && u.usedBytes >= u.limitBytes)).length;
  const disabledUsers = users.filter(u => u.status === 'disabled').length;

  const totalLimitBytes = users.reduce((acc, u) => acc + (u.limitBytes || 0), 0);
  const totalUsedBytes = users.reduce((acc, u) => acc + (u.usedBytes || 0), 0);

  res.json({
    success: true,
    stats: {
      totalUsers,
      activeUsers,
      expiredUsers,
      disabledUsers,
      totalLimitBytes,
      totalUsedBytes
    }
  });
});

app.get('/api/users', authMiddleware, (req, res) => {
  const users = getUsers();
  res.json({ success: true, users });
});

app.post('/api/users', authMiddleware, (req, res) => {
  const { name, limitGB, expireDays } = req.body;

  if (!name || name.trim() === '') {
    return res.status(400).json({ success: false, message: 'نام کاربر نمی‌تواند خالی باشد.' });
  }

  const users = getUsers();
  const limitBytes = limitGB ? parseFloat(limitGB) * 1024 * 1024 * 1024 : 0;
  
  let expireDate = null;
  if (expireDays && parseInt(expireDays) > 0) {
    const d = new Date();
    d.setDate(d.getDate() + parseInt(expireDays));
    expireDate = d.toISOString().split('T')[0];
  }

  const newUser = {
    id: uuidv4(),
    name: name.trim(),
    uuid: uuidv4(),
    limitBytes: limitBytes,
    usedBytes: 0,
    expireDate: expireDate,
    status: 'active',
    createdAt: new Date().toISOString()
  };

  users.push(newUser);
  saveUsers(users);

  sendTelegramMessage(`✨ **کاربر جدید ایجاد شد**\n👤 نام: ${newUser.name}\n📊 حجم: ${limitGB ? limitGB + ' GB' : 'نامحدود'}\n⏳ مدت: ${expireDays ? expireDays + ' روز' : 'نامحدود'}`);

  res.json({ success: true, message: 'کاربر جدید با موفقیت ایجاد شد.', user: newUser });
});

app.put('/api/users/:id', authMiddleware, (req, res) => {
  const { id } = req.params;
  const { name, limitGB, expireDate, status } = req.body;
  const users = getUsers();

  const userIndex = users.findIndex(u => u.id === id);
  if (userIndex === -1) {
    return res.status(404).json({ success: false, message: 'کاربر یافت نشد.' });
  }

  if (name) users[userIndex].name = name.trim();
  if (limitGB !== undefined) users[userIndex].limitBytes = parseFloat(limitGB) * 1024 * 1024 * 1024;
  if (expireDate !== undefined) users[userIndex].expireDate = expireDate;
  if (status) users[userIndex].status = status;

  saveUsers(users);
  res.json({ success: true, message: 'اطلاعات کاربر با موفقیت ویرایش شد.', user: users[userIndex] });
});

app.post('/api/users/:id/reset-traffic', authMiddleware, (req, res) => {
  const { id } = req.params;
  const users = getUsers();
  const user = users.find(u => u.id === id);

  if (!user) {
    return res.status(404).json({ success: false, message: 'کاربر یافت نشد.' });
  }

  user.usedBytes = 0;
  saveUsers(users);
  res.json({ success: true, message: 'ترافیک مصرفی کاربر صفر شد.' });
});

app.delete('/api/users/:id', authMiddleware, (req, res) => {
  const { id } = req.params;
  let users = getUsers();
  const initialLength = users.length;

  users = users.filter(u => u.id !== id);

  if (users.length === initialLength) {
    return res.status(404).json({ success: false, message: 'کاربر یافت نشد.' });
  }

  saveUsers(users);
  res.json({ success: true, message: 'کاربر با موفقیت حذف شد.' });
});

// ---- سیستم اشتراک هوشمند (/sub/:uuid) ----

app.get('/sub/:uuid', (req, res) => {
  const { uuid } = req.params;
  const users = getUsers();
  const user = users.find(u => u.uuid === uuid);

  if (!user) {
    return res.status(404).send('کاربر یافت نشد / User Not Found');
  }

  const settings = getSettings();
  const host = req.get('host') || '127.0.0.1';
  const domainOnly = host.split(':')[0];

  const connectAddress = settings.cleanIp && settings.cleanIp.trim() !== '' ? settings.cleanIp.trim() : domainOnly;

  const configsList = [];

  if (settings.enableVlessWs !== false) {
    configsList.push(`vless://${user.uuid}@${connectAddress}:443?type=ws&path=%2Fvless&security=tls&encryption=none&fp=chrome&sni=${domainOnly}&host=${domainOnly}#${encodeURIComponent(user.name + ' | VLESS-WS')}`);
  }

  if (settings.enableVlessGrpc !== false) {
    configsList.push(`vless://${user.uuid}@${connectAddress}:443?mode=gun&security=tls&encryption=none&type=grpc&serviceName=${encodeURIComponent(settings.serviceName || 'vless-grpc')}&fp=chrome&sni=${domainOnly}#${encodeURIComponent(user.name + ' | VLESS-gRPC')}`);
  }

  if (settings.enableTrojanWs !== false) {
    configsList.push(`trojan://${settings.trojanPassword || 'purple_trojan_pass'}@${connectAddress}:443?type=ws&path=%2Ftrojan&security=tls&fp=chrome&sni=${domainOnly}&host=${domainOnly}#${encodeURIComponent(user.name + ' | Trojan-WS')}`);
  }

  const combinedConfigs = configsList.join('\n');
  const base64Config = Buffer.from(combinedConfigs).toString('base64');

  const userAgent = (req.headers['user-agent'] || '').toLowerCase();
  const acceptHeader = (req.headers['accept'] || '').toLowerCase();
  const secChUa = req.headers['sec-ch-ua'];
  const acceptLanguage = req.headers['accept-language'];

  const isVpnClient = /v2ray|xray|shadowrocket|nekobox|sing-box|clash|stash|quantumult|streisand|passwall|sagernet|surfboard|hiddify|flclash|matsuri|v2fly|go-http-client|axios|fetch|curl|wget|winhttp|system\.net\.http|netcore|csharp|golang/i.test(userAgent);
  
  const forceHtml = req.query.html === 'true' || req.query.format === 'html';
  const forceRaw = req.query.raw === 'true' || req.query.config === 'true' || req.query.format === 'base64';

  const isRealBrowser = (secChUa || acceptLanguage) && userAgent.includes('mozilla') && !isVpnClient;
  const shouldRenderHtml = (forceHtml || isRealBrowser) && !forceRaw;

  if (shouldRenderHtml) {
    const usedGB = (user.usedBytes / (1024 * 1024 * 1024)).toFixed(2);
    const limitGB = user.limitBytes > 0 ? (user.limitBytes / (1024 * 1024 * 1024)).toFixed(2) : 'نامحدود';
    let percentUsed = 0;
    if (user.limitBytes > 0) {
      percentUsed = Math.min(100, Math.round((user.usedBytes / user.limitBytes) * 100));
    }

    let daysRemainingText = 'نامحدود';
    let isExpired = false;
    const today = new Date();
    if (user.expireDate) {
      const expDate = new Date(user.expireDate);
      const diffTime = expDate - today;
      const diffDays = Math.ceil(diffTime / (1024 * 60 * 60 * 24));
      if (diffDays <= 0) {
        daysRemainingText = 'منقضی شده';
        isExpired = true;
      } else {
        daysRemainingText = `${diffDays} روز باقی‌مانده`;
      }
    }

    if (user.limitBytes > 0 && user.usedBytes >= user.limitBytes) {
      isExpired = true;
    }

    const currentSubUrl = `${req.protocol}://${host}/sub/${user.uuid}`;

    const htmlPage = `
    <!DOCTYPE html>
    <html lang="fa" dir="rtl">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
      <title>PURPLE | وضعیت اشتراک ${user.name}</title>
      <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.rtl.min.css">
      <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
      <link href="https://cdn.jsdelivr.net/gh/rastikerdar/vazirmatn@v33.003/Vazirmatn-font-face.css" rel="stylesheet">
      <style>
        :root {
          --bg-dark: #0a0418;
          --card-bg: rgba(26, 10, 48, 0.92);
          --accent-purple: #a855f7;
          --accent-purple2: #c084fc;
          --accent-purple3: #d8b4fe;
        }
        body {
          font-family: 'Vazirmatn', sans-serif;
          background: radial-gradient(circle at top, #2c1250 0%, #0a0418 60%);
          color: #f3e8ff;
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 16px;
          margin: 0;
        }
        .sub-card {
          background: var(--card-bg);
          backdrop-filter: blur(20px);
          -webkit-backdrop-filter: blur(20px);
          border: 1px solid rgba(168, 85, 247, 0.25);
          border-radius: 28px;
          padding: 28px;
          max-width: 460px;
          width: 100%;
          box-shadow: 0 25px 60px rgba(76, 29, 149, 0.6);
        }
        .brand-header {
          display: flex;
          align-items: center;
          gap: 12px;
          margin-bottom: 24px;
        }
        .brand-icon-box {
          width: 48px;
          height: 48px;
          background: linear-gradient(135deg, #a855f7, #c084fc);
          border-radius: 16px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 22px;
          color: white;
          box-shadow: 0 8px 20px rgba(168, 85, 247, 0.5);
        }
        .status-pill {
          padding: 6px 14px;
          border-radius: 50px;
          font-size: 0.8rem;
          font-weight: 700;
        }
        .progress-track {
          height: 14px;
          border-radius: 8px;
          background: #1a0a30;
          overflow: hidden;
          padding: 2px;
        }
        .progress-bar-fill {
          height: 100%;
          border-radius: 6px;
          background: linear-gradient(90deg, #a855f7, #c084fc);
          transition: width 0.6s ease;
        }
        .progress-bar-fill.warning {
          background: linear-gradient(90deg, #f59e0b, #ef4444);
        }
        .stat-box {
          background: rgba(26, 10, 48, 0.7);
          border: 1px solid rgba(168, 85, 247, 0.2);
          border-radius: 18px;
          padding: 14px;
          text-align: center;
        }
        .qr-box {
          background: #ffffff;
          padding: 12px;
          border-radius: 20px;
          display: inline-block;
          box-shadow: 0 10px 25px rgba(168, 85, 247, 0.3);
        }
        .btn-custom-action {
          border-radius: 14px;
          padding: 14px;
          font-weight: 700;
          font-size: 0.95rem;
          transition: all 0.25s ease;
        }
        .btn-custom-action:hover {
          transform: translateY(-2px);
          box-shadow: 0 8px 20px rgba(168, 85, 247, 0.4);
        }
        .btn-primary {
          background: linear-gradient(135deg, #a855f7, #7e22ce);
          border: none;
        }
        .btn-primary:hover { background: linear-gradient(135deg, #c084fc, #9333ea); }
        .text-info { color: #d8b4fe !important; }
        .text-warning { color: #c084fc !important; }
      </style>
    </head>
    <body>
      <div class="sub-card">
        <div class="d-flex justify-content-between align-items-center mb-4">
          <div class="brand-header mb-0">
            <div class="brand-icon-box">
              <i class="fa-solid fa-bolt"></i>
            </div>
            <div>
              <h5 class="mb-0 text-white fw-bold">${user.name}</h5>
              <span class="text-muted small" style="font-size: 0.78rem;color:#c4a5e8 !important;">PURPLE</span>
            </div>
          </div>
          <span class="status-pill ${isExpired ? 'bg-danger text-white' : 'bg-success text-white'}">
            ${isExpired ? 'منقضی' : 'فعال'}
          </span>
        </div>

        <div class="mb-4">
          <div class="d-flex justify-content-between mb-2 small">
            <span style="color:#c4a5e8;">حجم مصرفی: <strong class="text-white">${usedGB} GB</strong></span>
            <span style="color:#c4a5e8;">حجم کل: <strong class="text-white">${limitGB} ${limitGB !== 'نامحدود' ? 'GB' : ''}</strong></span>
          </div>
          <div class="progress-track">
            <div class="progress-bar-fill ${percentUsed > 85 ? 'warning' : ''}" style="width: ${percentUsed}%"></div>
          </div>
        </div>

        <div class="row g-3 mb-4">
          <div class="col-6">
            <div class="stat-box">
              <div class="small mb-1" style="color:#c4a5e8;">اعتبار زمانی</div>
              <div class="fw-bold" style="color:#d8b4fe;">${daysRemainingText}</div>
            </div>
          </div>
          <div class="col-6">
            <div class="stat-box">
              <div class="small mb-1" style="color:#c4a5e8;">درصد مصرف</div>
              <div class="fw-bold" style="color:#c084fc;">${user.limitBytes > 0 ? percentUsed + '%' : '0%'}</div>
            </div>
          </div>
        </div>

        <div class="text-center mb-4">
          <div class="qr-box mb-2">
            <img src="https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(currentSubUrl)}" alt="QR Code" width="180" height="180">
          </div>
          <div class="small" style="font-size: 0.8rem;color:#c4a5e8;">اسکن بارکد در v2rayNG / Shadowrocket / NekoBox</div>
        </div>

        <div class="d-grid gap-2 mb-3">
          <button class="btn btn-primary btn-custom-action" onclick="copyText('${currentSubUrl}', 'لینک ساب اشتراک با موفقیت کپی شد!')">
            <i class="fa-solid fa-link me-2"></i> کپی لینک ساب (Subscription)
          </button>
          <button class="btn btn-outline-light btn-custom-action" onclick="copyText(\`${combinedConfigs}\`, 'تمامی کانفیگ‌های VLESS و Trojan کپی شدند!')">
            <i class="fa-solid fa-copy me-2"></i> کپی مستقیم کانفیگ‌ها
          </button>
        </div>

        <div id="toast" class="alert alert-success text-center d-none p-2 small rounded-3"></div>
      </div>

      <script>
        function copyText(text, msg) {
          navigator.clipboard.writeText(text).then(() => {
            const toast = document.getElementById('toast');
            toast.innerText = msg;
            toast.classList.remove('d-none');
            setTimeout(() => toast.classList.add('d-none'), 3500);
          }).catch(() => {
            alert('امکان کپی خودکار وجود ندارد.');
          });
        }
      </script>
    </body>
    </html>
    `;
    return res.send(htmlPage);
  }

  const expireTimestamp = user.expireDate ? Math.floor(new Date(user.expireDate).getTime() / 1000) : 0;
  res.setHeader('Subscription-Userinfo', `upload=0; download=${user.usedBytes}; total=${user.limitBytes || 0}; expire=${expireTimestamp}`);
  res.setHeader('profile-title', `base64:${Buffer.from(user.name).toString('base64')}`);
  res.setHeader('profile-update-interval', '24');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  return res.send(base64Config);
});

app.get('/guide', (req, res) => {
  res.sendFile(path.join(__dirname, 'guide.html'));
});

// ایجاد سرور HTTP
const server = http.createServer(app);

server.on('upgrade', (req, socket, head) => {
  const url = req.url || '';
  
  if (url.startsWith('/vless') || req.headers['sec-websocket-protocol'] === 'vless') {
    const targetSocket = net.connect({ port: 2083, host: '127.0.0.1' }, () => {
      let rawRequest = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        rawRequest += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
      }
      rawRequest += '\r\n';

      targetSocket.write(rawRequest);
      if (head && head.length > 0) targetSocket.write(head);

      socket.pipe(targetSocket);
      targetSocket.pipe(socket);
    });

    targetSocket.on('error', () => socket.destroy());
    socket.on('error', () => targetSocket.destroy());
  } else if (url.startsWith('/trojan')) {
    const targetSocket = net.connect({ port: 2085, host: '127.0.0.1' }, () => {
      let rawRequest = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        rawRequest += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
      }
      rawRequest += '\r\n';

      targetSocket.write(rawRequest);
      if (head && head.length > 0) targetSocket.write(head);

      socket.pipe(targetSocket);
      targetSocket.pipe(socket);
    });

    targetSocket.on('error', () => socket.destroy());
    socket.on('error', () => targetSocket.destroy());
  } else {
    socket.destroy();
  }
});

// راه‌اندازی
rebuildSingboxConfig();
initTelegramBot();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`====================================================`);
  console.log(`🚀 پنل مدیریت «PURPLE» (Purple VPN Panel) اجرا شد.`);
  console.log(`🌐 پورت سرور: ${PORT}`);
  console.log(`📁 مسیر داده‌ها: ${DATA_DIR}`);
  console.log(`====================================================`);
});

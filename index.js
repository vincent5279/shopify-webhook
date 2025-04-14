// 📦 Shopify 客戶地址通知系統（繁體中文 + 精準邏輯）
// 功能：每次變更預設地址或額外地址時準確發送對應通知（新增/變更/刪除）

const express = require("express");
const crypto = require("crypto");
const { DateTime } = require("luxon");
const nodemailer = require("nodemailer");

const app = express();
app.use(express.json());

const customerStore = {}; // { [customerId]: { defaultHash, extraHash } }

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER || "takshing78@gmail.com",
    pass: process.env.EMAIL_PASS || "whfa ugtr frbg tujw"
  }
});

function hashAddresses(addresses) {
  if (!addresses || addresses.length === 0) return "";
  const content = addresses
    .map(a => `${a.address1}-${a.address2}-${a.city}-${a.province}-${a.zip}-${a.country}`)
    .join("|")
    .toLowerCase();
  return crypto.createHash("sha256").update(content).digest("hex");
}

function buildEmailBody(customer, action) {
  const createdAt = DateTime.now().setZone("Asia/Hong_Kong").toFormat("yyyy/MM/dd HH:mm:ss");
  let body = `📬 客戶地址${action}通知\n`;
  body += `──────────────────\n`;
  body += `👤 姓名      ：${customer.first_name} ${customer.last_name}\n`;
  body += `📧 電郵      ：${customer.email}\n`;
  body += `🗓️ 通知寄出時間：${createdAt}（香港時間）\n`;
  body += `──────────────────\n\n`;

  const addresses = customer.addresses || [];
  if (addresses.length === 0) {
    body += `🏠 地址列表：目前無任何地址\n`;
  } else {
    body += `🏠 地址列表：共 ${addresses.length} 筆\n`;
    addresses.forEach((addr, i) => {
      body += `\n【地址 ${i + 1}】──────────────────\n`;
      body += `🏢 公司    ：${addr.company || "未提供"}\n`;
      body += `📍 地址一  ：${addr.address1}\n`;
      body += `📍 地址二  ：${addr.address2 || "未提供"}\n`;
      body += `🏙️ 城市    ：${addr.city}\n`;
      body += `🏞️ 省份    ：${addr.province}\n`;
      body += `🌍 國家    ：${addr.country}\n`;
      body += `📞 電話    ：${addr.phone || "未提供"}\n`;
    });
  }
  return body;
}

function sendNotification(customer, action, res) {
  const body = buildEmailBody(customer, action);
  transporter.sendMail({
    from: process.env.EMAIL_USER,
    to: process.env.EMAIL_USER,
    subject: `📢 客戶地址${action}`,
    text: body
  }, (err) => {
    if (err) return res.status(500).send("❌ 寄信錯誤");
    res.send(`📨 已寄出通知：${action}`);
  });
}

app.post("/webhook", (req, res) => {
  const customer = req.body;
  const id = customer.id.toString();

  const addresses = customer.addresses || [];
  const defaultAddress = customer.default_address || null;
  const extraAddresses = addresses.filter(a => a.id !== defaultAddress?.id);

  const defaultHash = hashAddresses(defaultAddress ? [defaultAddress] : []);
  const extraHash = hashAddresses(extraAddresses);

  const isFirstTime = !customerStore[id];
  let action = null;

  if (isFirstTime) {
    // 第一次，不要判斷變更，只處理「是否有地址」
    if (addresses.length > 0) {
      action = "新增地址";
    } else {
      return res.send("✅ 第一次接收，無地址，略過");
    }
  } else {
    const last = customerStore[id];

    if (!last.defaultHash && defaultHash) {
      action = "加入預設地址";
    } else if (last.defaultHash && !defaultHash) {
      action = "刪除預設地址";
    } else if (last.defaultHash !== defaultHash) {
      action = "變更預設地址";
    } else if (!last.extraHash && extraHash) {
      action = "新增地址";
    } else if (last.extraHash && !extraHash) {
      action = "刪除地址";
    } else if (last.extraHash !== extraHash) {
      action = "更新地址";
    } else {
      return res.send("✅ 無地址變更");
    }
  }

  // 儲存目前狀態
  customerStore[id] = { defaultHash, extraHash };
  sendNotification(customer, action, res);
});

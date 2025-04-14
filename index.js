// 📦 Shopify 客戶地址通知系統（繁體中文版本 + Luxon + 預設地址變更邏輯）
// 功能：當客戶新增、修改、刪除地址、變更/加入/刪除預設地址時，自動寄送通知信

const express = require("express");
const bodyParser = require("body-parser");
const nodemailer = require("nodemailer");
const crypto = require("crypto");
const { DateTime } = require("luxon"); // 使用 luxon 處理時區

const app = express();
app.use(bodyParser.json());

// 🧠 暫存記憶體資料（正式請用資料庫）
const customerStore = {}; // { [customerId]: { addressCount, hash, updatedAt, defaultId } }

// ✉️ Gmail SMTP 設定
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER || "takshing78@gmail.com",
    pass: process.env.EMAIL_PASS || ""
  }
});

// 📩 接收 Shopify Webhook
app.post("/webhook", (req, res) => {
  const customer = req.body;
  const id = customer.id.toString();
  const addresses = customer.addresses || [];
  const updatedAt = customer.updated_at;
  const addressCount = addresses.length;
  const hash = hashAddresses(addresses);
  const defaultId = customer.default_address?.id || null;

  const last = customerStore[id] || {
    addressCount: 0,
    hash: "",
    updatedAt: "",
    defaultId: null
  };

  let action = null;
  const hadDefault = last.defaultId !== null;
  const hasDefault = defaultId !== null;

  // ✅ 預設地址處理邏輯
  if (!hadDefault && hasDefault) {
    action = "加入預設地址";
  } else if (hadDefault && !hasDefault) {
    action = "刪除預設地址";
  } else if (defaultId !== last.defaultId) {
    action = "變更預設地址";
  } else if (updatedAt === last.updatedAt) {
    return res.send("⏩ 已處理，略過");
  } else if (addressCount > last.addressCount) {
    action = "新增地址";
  } else if (addressCount < last.addressCount) {
    action = "刪除地址";
  } else if (hash !== last.hash) {
    action = "更新地址";
  } else {
    return res.send("✅ 無地址變更");
  }

  const body = buildEmailBody(customer, action);

  transporter.sendMail({
    from: process.env.EMAIL_USER || "takshing78@gmail.com",
    to: process.env.EMAIL_USER || "takshing78@gmail.com",
    subject: `📢 客戶地址${action}`,
    text: body
  }, (err, info) => {
    if (err) return res.status(500).send("❌ 寄信錯誤");
    customerStore[id] = { addressCount, hash, updatedAt, defaultId };
    res.send(`📨 已寄出通知：${action}`);
  });
});

// 🧠 建立地址內容的 hash
function hashAddresses(addresses) {
  const content = addresses.map(a => `${a.address1}-${a.city}`).join("|").toLowerCase();
  return crypto.createHash("md5").update(content).digest("hex");
}

// 📤 組成郵件內容
function buildEmailBody(customer, action) {
  const createdAt = customer.created_at
    ? DateTime.fromISO(customer.created_at, { zone: "utc" })
        .setZone("Asia/Hong_Kong")
        .toFormat("yyyy/MM/dd HH:mm:ss")
    : "未提供";

  let body = `📬 客戶地址${action}通知\n`;
  body += `──────────────────\n`;
  body += `👤 姓名      ：${customer.first_name} ${customer.last_name}\n`;
  body += `📧 電郵      ：${customer.email}\n`;
  body += `🗓️ 建立時間：${createdAt}（香港時間）\n`;
  body += `──────────────────\n\n`;

  if (customer.addresses.length === 0) {
    body += `🏠 地址列表：目前無任何地址\n`;
  } else {
    body += `🏠 地址列表：共 ${customer.addresses.length} 筆\n`;

    customer.addresses.forEach((addr, i) => {
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

// 🚀 啟動伺服器
const PORT = process.env.PORT || 3000;
app.get("/", (req, res) => {
  res.send("✅ Webhook 伺服器正在運行。請使用 POST /webhook 傳送 Shopify 客戶資料。");
});

app.listen(PORT, () => {
  console.log(`📡 Webhook 伺服器啟動於 http://localhost:${PORT}`);
});

// 📦 Shopify 客戶地址通知系統（繁體中文版本 + Luxon + 精準預設與額外地址變更邏輯）

const express = require("express");
const bodyParser = require("body-parser");
const nodemailer = require("nodemailer");
const crypto = require("crypto");
const { DateTime } = require("luxon");

const app = express();
app.use(bodyParser.json());

const customerStore = {}; // { [customerId]: { addressesHash, defaultHash } }

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER || "takshing78@gmail.com",
    pass: process.env.EMAIL_PASS || "whfa ugtr frbg tujw"
  }
});

app.post("/webhook", (req, res) => {
  const customer = req.body;
  const id = customer.id.toString();
  const addresses = customer.addresses || [];
  const defaultAddress = customer.default_address || null;

  const defaultHash = hashAddresses(defaultAddress ? [defaultAddress] : []);
  const extraAddresses = addresses.filter(a => a.id !== defaultAddress?.id);
  const extraHash = hashAddresses(extraAddresses);

  const last = customerStore[id] || { addressesHash: "", defaultHash: "" };

  let action = null;

  if (!last.defaultHash && defaultHash) {
    action = "加入預設地址";
  } else if (last.defaultHash && !defaultHash) {
    action = "刪除預設地址";
  } else if (last.defaultHash !== defaultHash) {
    action = "變更預設地址";
  } else if (!last.addressesHash && extraHash) {
    action = "新增地址";
  } else if (last.addressesHash && !extraHash) {
    action = "刪除地址";
  } else if (last.addressesHash !== extraHash) {
    action = "更新地址";
  } else {
    return res.send("✅ 無地址變更");
  }

  const body = buildEmailBody(customer, action);
  sendNotification(customer, action, body, res);
  customerStore[id] = { addressesHash: extraHash, defaultHash };
});

function sendNotification(customer, action, body, res) {
  transporter.sendMail({
    from: process.env.EMAIL_USER || "takshing78@gmail.com",
    to: process.env.EMAIL_USER || "takshing78@gmail.com",
    subject: `📢 客戶地址${action}`,
    text: body
  }, (err, info) => {
    if (err) return res.status(500).send("❌ 寄信錯誤");
    res.send(`📨 已寄出通知：${action}`);
  });
}

function hashAddresses(addresses) {
  const content = addresses.map(a => `${a.address1}-${a.address2}-${a.city}-${a.province}-${a.zip}-${a.country}`).join("|").toLowerCase();
  return crypto.createHash("md5").update(content).digest("hex");
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

const PORT = process.env.PORT || 3000;
app.get("/", (req, res) => {
  res.send("✅ Webhook 伺服器正在運行。請使用 POST /webhook 傳送 Shopify 客戶資料。");
});

app.listen(PORT, () => {
  console.log(`📡 Webhook 伺服器啟動於 http://localhost:${PORT}`);
});

// 📦 Shopify 客戶地址與帳戶通知系統（繁體中文 + 精準邏輯 + 註冊 + 刪除通知 + CORS）

const express = require("express");
const crypto = require("crypto");
const { DateTime } = require("luxon");
const nodemailer = require("nodemailer");
const cors = require("cors");

const app = express();
app.use(cors());
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

function formatEmailBody(customer, action) {
  const createdAt = DateTime.now().setZone("Asia/Hong_Kong").toFormat("yyyy/MM/dd HH:mm:ss");
  let body = `📬 客戶地址${action}通知\n`;
  body += `──────────────────\n`;
  body += `👤 姓名：${customer.first_name} ${customer.last_name}\n`;
  body += `📧 電郵：${customer.email}\n`;
  body += `🗓️ 通知寄出時間：${createdAt}（香港時間）\n`;
  body += `──────────────────\n\n`;

  const addresses = customer.addresses || [];
  if (addresses.length === 0) {
    body += `🏠 地址列表：目前無任何地址\n`;
  } else {
    body += `🏠 地址列表：共 ${addresses.length} 筆\n`;
    addresses.forEach((addr, i) => {
      body += `\n【地址 ${i + 1}】──────────────────\n`;
      body += `🏢 公司：${addr.company || "未提供"}\n`;
      body += `📍 地址一：${addr.address1}\n`;
      body += `📍 地址二：${addr.address2 || "未提供"}\n`;
      body += `🏙️ 城市：${addr.city}\n`;
      body += `🏞️ 省份：${addr.province}\n`;
      body += `🌍 國家：${addr.country}\n`;
      body += `📞 電話：${addr.phone || "未提供"}\n`;
    });
  }
  return body;
}

function sendNotification(to, subject, text) {
  return transporter.sendMail({
    from: `"德成電業客服中心" <${process.env.EMAIL_USER}>`,
    to,
    subject,
    text
  });
}

// 地址變動 Webhook
app.post("/webhook", async (req, res) => {
  const customer = req.body;
  const id = customer.id.toString();

  const addresses = customer.addresses || [];
  const defaultAddress = customer.default_address || null;
  const extraAddresses = addresses.filter(a => a.id !== defaultAddress?.id);

  const defaultHash = hashAddresses(defaultAddress ? [defaultAddress] : []);
  const extraHash = hashAddresses(extraAddresses);

  const last = customerStore[id] || { defaultHash: "", extraHash: "" };
  const isFirstTime = !customerStore[id];
  const defaultChanged = last.defaultHash !== defaultHash;
  const extraChanged = last.extraHash !== extraHash;

  let action = null;
  if (isFirstTime && !defaultChanged && !extraChanged) return res.send("✅ 第一次略過");

  if (!isFirstTime && !last.defaultHash && defaultHash) action = "加入預設地址";
  else if (!isFirstTime && last.defaultHash && !defaultHash) action = "刪除預設地址";
  else if (defaultChanged) action = "變更預設地址";
  else if (!last.extraHash && extraHash) action = "新增地址";
  else if (last.extraHash && !extraHash) action = "刪除地址";
  else if (extraChanged) action = "更新地址";
  else return res.send("✅ 無地址變更");

  customerStore[id] = { defaultHash, extraHash };

  const body = formatEmailBody(customer, action);
  try {
    await sendNotification([process.env.EMAIL_USER, customer.email], `📢 客戶地址${action}`, body);
    res.send(`📨 已寄出通知：${action}`);
  } catch (err) {
    res.status(500).send("❌ 郵件寄送失敗");
  }
});

// 刪除帳戶通知
app.post("/delete-account", async (req, res) => {
  const { id, email, first_name, last_name } = req.body;
  delete customerStore[id];

  const time = DateTime.now().setZone("Asia/Hong_Kong").toFormat("yyyy/MM/dd HH:mm:ss");

  const msg_to_user = `👋 ${first_name} ${last_name} 您好，

您已成功刪除 Shopify 帳戶。
我們已於 ${time}（香港時間）移除與您相關的所有地址通知記錄與系統記憶。

🧠 所有紀錄已被永久清除，若您日後重新註冊，我們將視為全新帳戶。

謝謝您曾使用我們的服務 🙏`;

  const msg_to_admin = `🗑️ 客戶已刪除帳戶\n\n👤 姓名：${first_name} ${last_name}\n📧 電郵：${email}\n🕒 時間：${time}（香港時間）`;

  try {
    await sendNotification(email, "✅ 您的帳戶已成功刪除", msg_to_user);
    await sendNotification(process.env.EMAIL_USER, "🗑️ 有客戶刪除帳戶", msg_to_admin);
    res.send("✅ 帳戶資料已刪除並已通知雙方");
  } catch (err) {
    res.status(500).send("❌ 刪除通知發送失敗");
  }
});

// 註冊通知
app.post("/webhook/new-customer", async (req, res) => {
  const { email, first_name, last_name } = req.body;
  const time = DateTime.now().setZone("Asia/Hong_Kong").toFormat("yyyy/MM/dd HH:mm:ss");
  const msg = `🆕 有新客戶註冊：

姓名：${first_name} ${last_name}
電郵：${email}
時間：${time}（香港時間）`;

  try {
    await sendNotification(process.env.EMAIL_USER, "🆕 有新客戶註冊帳號", msg);
    res.send("✅ 公司已收到新客戶通知");
  } catch (err) {
    res.status(500).send("❌ 新客戶通知發送失敗");
  }
});

app.get("/", (req, res) => {
  res.send("✅ Webhook 伺服器正常運行");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`📡 Webhook 啟動於 http://localhost:${PORT}`);
});

// 📦 Shopify 客戶通知系統（修正重複刪除通知問題）

const express = require("express");
const crypto = require("crypto");
const { DateTime } = require("luxon");
const nodemailer = require("nodemailer");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const customerStore = {}; // { [id]: { notified, defaultHash, extraHash, deleted: true } }

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER || "takshing78@gmail.com",
    pass: process.env.EMAIL_PASS || "whfa ugtr frbg tujw"
  }
});

function sendNotification({ toAdmin = true, toCustomer = false, customer, subject, body }) {
  const recipients = [];
  if (toAdmin) recipients.push(process.env.EMAIL_USER);
  if (toCustomer && customer?.email) recipients.push(customer.email);

  return transporter.sendMail({
    from: `"德成電業客服中心" <${process.env.EMAIL_USER}>`,
    to: recipients,
    subject,
    text: body
  });
}

function hashAddresses(addresses) {
  if (!addresses || addresses.length === 0) return "";
  const content = addresses
    .map(a => `${a.address1}-${a.address2}-${a.city}-${a.province}-${a.zip}-${a.country}`)
    .join("|")
    .toLowerCase();
  return crypto.createHash("sha256").update(content).digest("hex");
}

// ✅ 註冊通知
app.post("/webhook/new-customer", async (req, res) => {
  const { id, email, first_name, last_name } = req.body;
  if (!id) return res.status(400).send("❌ 缺少 customer ID");

  const existing = customerStore[id];
  if (existing && !existing.deleted) {
    return res.send("✅ 此帳戶已存在且未刪除，略過通知");
  }

  const time = DateTime.now().setZone("Asia/Hong_Kong").toFormat("yyyy/MM/dd HH:mm:ss");
  const msg = `🆕 有新客戶註冊帳號：

👤 姓名：${first_name} ${last_name}
📧 電郵：${email}
🕒 註冊時間：${time}（香港時間）`;

  try {
    await sendNotification({
      toAdmin: true,
      toCustomer: false,
      subject: "🆕 有新客戶註冊帳號",
      body: msg
    });

    customerStore[id] = { notified: true, defaultHash: "", extraHash: "", deleted: false };
    res.send("✅ 公司已收到註冊通知");
  } catch (err) {
    res.status(500).send("❌ 註冊通知寄送失敗");
  }
});

// ✅ 地址變更通知
app.post("/webhook", async (req, res) => {
  const customer = req.body;
  const id = customer.id?.toString();
  if (!id) return res.status(400).send("❌ 缺少 customer ID");

  const defaultAddress = customer.default_address || null;
  const extraAddresses = (customer.addresses || []).filter(a => a.id !== defaultAddress?.id);
  const defaultHash = hashAddresses(defaultAddress ? [defaultAddress] : []);
  const extraHash = hashAddresses(extraAddresses);

  const last = customerStore[id];

  if (!last) {
    customerStore[id] = { notified: true, defaultHash, extraHash, deleted: false };
    return res.send("✅ 首次地址初始化，不寄信");
  }

  const defaultChanged = last.defaultHash !== defaultHash;
  const extraChanged = last.extraHash !== extraHash;

  let action = null;
  if (!last.defaultHash && defaultHash) action = "加入預設地址";
  else if (last.defaultHash && !defaultHash) action = "刪除預設地址";
  else if (defaultChanged) action = "變更預設地址";
  else if (!last.extraHash && extraHash) action = "新增地址";
  else if (last.extraHash && !extraHash) action = "刪除地址";
  else if (extraChanged) action = "更新地址";
  else {
    customerStore[id] = { ...last, defaultHash, extraHash };
    return res.send("✅ 無地址變更");
  }

  customerStore[id] = { ...last, defaultHash, extraHash };

  const body = formatEmailBody(customer, action);
  try {
    await sendNotification({
      toAdmin: true,
      toCustomer: false,
      subject: `📢 客戶地址${action}`,
      body,
      customer
    });
    res.send(`📨 地址變更通知：${action}`);
  } catch (err) {
    res.status(500).send("❌ 地址變更通知寄送失敗");
  }
});

// ✅ 刪除帳戶通知（只給用戶，且僅一次）
app.post("/delete-account", async (req, res) => {
  const { id, email, first_name, last_name } = req.body;
  if (!id || !email) return res.status(400).send("❌ 缺少 ID 或 Email");

  const last = customerStore[id];
  if (last?.deleted) {
    return res.send("✅ 已寄送過刪除確認信，略過");
  }

  const time = DateTime.now().setZone("Asia/Hong_Kong").toFormat("yyyy/MM/dd HH:mm:ss");
  const msg = `👋 ${first_name} ${last_name} 您好，

您已成功刪除 Shopify 帳戶。
我們已於 ${time}（香港時間）清除與您相關的通知紀錄與記憶。

🧠 所有資料已永久移除，若您重新註冊，我們將視為全新帳號。

謝謝您曾使用我們的服務 🙏`;

  try {
    await sendNotification({
      toAdmin: false,
      toCustomer: true,
      customer: { email },
      subject: "✅ 您的帳戶已成功刪除",
      body: msg
    });

    customerStore[id] = { deleted: true };
    res.send("✅ 刪除通知已發出");
  } catch (err) {
    res.status(500).send("❌ 刪除通知寄送失敗");
  }
});

// 📧 地址信件內容格式
function formatEmailBody(customer, action) {
  const time = DateTime.now().setZone("Asia/Hong_Kong").toFormat("yyyy/MM/dd HH:mm:ss");
  let body = `📬 客戶地址${action}通知\n`;
  body += `──────────────────\n`;
  body += `👤 姓名：${customer.first_name} ${customer.last_name}\n`;
  body += `📧 電郵：${customer.email}\n`;
  body += `🕒 通知寄出時間：${time}（香港時間）\n`;
  body += `──────────────────\n\n`;

  const addresses = customer.addresses || [];
  if (addresses.length === 0) {
    body += `🏠 地址列表：目前無任何地址\n`;
  } else {
    addresses.forEach((addr, i) => {
      body += `\n【地址 ${i + 1}】──────────────────\n`;
      body += `🏢 公司：${addr.company || "未提供"}\n`;
      body += `📍 地址一：${addr.address1 || "未提供"}\n`;
      body += `📍 地址二：${addr.address2 || "未提供"}\n`;
      body += `🏙️ 城市：${addr.city || "未提供"}\n`;
      body += `🏞️ 省份：${addr.province || "未提供"}\n`;
      body += `🌍 國家：${addr.country || "未提供"}\n`;
      body += `📞 電話：${addr.phone || "未提供"}\n`;
    });
  }

  return body;
}

app.get("/", (req, res) => {
  res.send("✅ Webhook 伺服器正常運行");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`📡 Webhook 啟動於 http://localhost:${PORT}`);
});

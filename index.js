// 📦 Shopify 客戶通知系統（繁體中文 + 每次註冊通知 + 地址變動通知 + 刪除帳號通知）

const express = require("express");
const crypto = require("crypto");
const { DateTime } = require("luxon");
const nodemailer = require("nodemailer");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const customerStore = {}; // { [customerId]: { notified: true, defaultHash, extraHash } }

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER || "takshing78@gmail.com",
    pass: process.env.EMAIL_PASS || "whfa ugtr frbg tujw"
  }
});

// ✉️ 統一寄信方法
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

// 📦 地址 hash
function hashAddresses(addresses) {
  if (!addresses || addresses.length === 0) return "";
  const content = addresses
    .map(a => `${a.address1}-${a.address2}-${a.city}-${a.province}-${a.zip}-${a.country}`)
    .join("|")
    .toLowerCase();
  return crypto.createHash("sha256").update(content).digest("hex");
}

// 🆕 註冊通知（每次註冊都通知，只要帳戶不是現存未刪除）
app.post("/webhook/new-customer", async (req, res) => {
  const { id, email, first_name, last_name } = req.body;
  if (!id) return res.status(400).send("❌ 缺少 customer ID");

  const deletedKey = `deleted_${id}`;
  if (customerStore[id] && !customerStore[deletedKey]) {
    return res.send("✅ 此帳戶已存在且尚未刪除，略過");
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

    customerStore[id] = { notified: true, defaultHash: "", extraHash: "" };
    delete customerStore[deletedKey];

    res.send("✅ 公司已收到註冊通知");
  } catch (err) {
    console.error("❌ 註冊通知寄送失敗", err);
    res.status(500).send("❌ 寄送失敗");
  }
});

app.post("/webhook", async (req, res) => {
  const customer = req.body;
  const id = customer.id?.toString();
  if (!id) return res.status(400).send("❌ 缺少 customer ID");

  const addresses = customer.addresses || [];
  const defaultAddress = customer.default_address || null;
  const extraAddresses = addresses.filter(a => a.id !== defaultAddress?.id);

  const defaultHash = hashAddresses(defaultAddress ? [defaultAddress] : []);
  const extraHash = hashAddresses(extraAddresses);

  const last = customerStore[id];

  // ✅ 如果是首次呼叫 webhook，先記錄地址 hash，但不寄信
  if (!last) {
    customerStore[id] = { defaultHash, extraHash, notified: true };
    return res.send("✅ 第一次登入紀錄地址，未發送通知");
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
      customer,
      subject: `📢 客戶地址${action}`,
      body
    });
    res.send(`📨 地址變更通知：${action}`);
  } catch (err) {
    res.status(500).send("❌ 郵件寄送失敗");
  }
});

// 🗑️ 刪除帳戶：只寄一次信給用戶本人
app.post("/delete-account", async (req, res) => {
  const { id, email, first_name, last_name } = req.body;
  if (!id || !email) return res.status(400).send("❌ 缺少帳戶 ID 或 Email");

  const deletedKey = `deleted_${id}`;
  if (customerStore[deletedKey]) {
    return res.send("✅ 該帳戶已處理過刪除確認信");
  }

  const time = DateTime.now().setZone("Asia/Hong_Kong").toFormat("yyyy/MM/dd HH:mm:ss");
  const body = `👋 ${first_name} ${last_name} 您好，

您已成功刪除 Shopify 帳戶。
我們已於 ${time}（香港時間）清除與您相關的通知記錄與記憶。

🧠 所有資料已永久移除，若您重新註冊，我們將視為全新帳號。

謝謝您曾使用我們的服務 🙏`;

  try {
    await sendNotification({
      toAdmin: false,
      toCustomer: true,
      customer: { email },
      subject: "✅ 您的帳戶已成功刪除",
      body
    });

    delete customerStore[id];
    customerStore[deletedKey] = true;

    res.send("✅ 已寄送刪除確認信給用戶");
  } catch (err) {
    console.error("❌ 刪除信寄送失敗", err);
    res.status(500).send("❌ 發送刪除確認信失敗");
  }
});

// 📧 地址格式組件
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

// 🧪 健康檢查
app.get("/", (req, res) => {
  res.send("✅ Webhook 伺服器正常運行");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`📡 Webhook 啟動於 http://localhost:${PORT}`);
});

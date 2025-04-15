// 📦 Shopify 客戶通知系統（繁體中文 + 精準邏輯 + 每次註冊都通知）

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

// 📨 組成信件內容
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

// 📡 地址變更 webhook
app.post("/webhook", async (req, res) => {
  const customer = req.body;
  const id = customer.id.toString();

  // 📩 每次 webhook 都當作一次登入觸發註冊通知
  const time = DateTime.now().setZone("Asia/Hong_Kong").toFormat("yyyy/MM/dd HH:mm:ss");
  const msg = `🆕 有新客戶登入或註冊：

👤 姓名：${customer.first_name} ${customer.last_name}
📧 電郵：${customer.email}
🕒 登入時間：${time}（香港時間）`;

  try {
    await sendNotification({
      toAdmin: true,
      toCustomer: false,
      subject: "🆕 有新客戶註冊帳號",
      body: msg
    });
  } catch (err) {
    console.error("❌ 寄送註冊通知失敗", err);
  }

  // 👉 地址檢查邏輯
  const addresses = customer.addresses || [];
  const defaultAddress = customer.default_address || null;
  const extraAddresses = addresses.filter(a => a.id !== defaultAddress?.id);

  const defaultHash = hashAddresses(defaultAddress ? [defaultAddress] : []);
  const extraHash = hashAddresses(extraAddresses);

  const last = customerStore[id] || { defaultHash: "", extraHash: "" };
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
    customerStore[id] = { defaultHash, extraHash };
    return res.send("✅ 無地址變更（但已發註冊通知）");
  }

  customerStore[id] = { defaultHash, extraHash };

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

// 🗑️ 刪除帳戶（只寄用戶）
app.post("/delete-account", async (req, res) => {
  const { id, email, first_name, last_name } = req.body;
  delete customerStore[id];

  const time = DateTime.now().setZone("Asia/Hong_Kong").toFormat("yyyy/MM/dd HH:mm:ss");

  const msg_to_user = `👋 ${first_name} ${last_name} 您好，

您已成功刪除 Shopify 帳戶。
我們已於 ${time}（香港時間）移除與您相關的所有地址通知記錄與系統記憶。

🧠 所有紀錄已被永久清除，若您日後重新註冊，我們將視為全新帳戶。

謝謝您曾使用我們的服務 🙏`;

  try {
    await sendNotification({
      toAdmin: false,
      toCustomer: true,
      customer: { email },
      subject: "✅ 您的帳戶已成功刪除",
      body: msg_to_user
    });

    res.send("✅ 已通知用戶刪除成功");
  } catch (err) {
    res.status(500).send("❌ 刪除通知失敗");
  }
});

app.get("/", (req, res) => {
  res.send("✅ Webhook 伺服器正常運行");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`📡 Webhook 啟動於 http://localhost:${PORT}`);
});

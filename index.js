// 📦 Shopify 客戶通知系統（修正註冊誤發地址通知 + 用戶只接收刪除信）

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

// ✉️ 統一寄信方法（公司 / 用戶 分流）
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

// 📦 產生地址 hash
function hashAddresses(addresses) {
  if (!addresses || addresses.length === 0) return "";
  const content = addresses
    .map(a => `${a.address1}-${a.address2}-${a.city}-${a.province}-${a.zip}-${a.country}`)
    .join("|")
    .toLowerCase();
  return crypto.createHash("sha256").update(content).digest("hex");
}

// 📨 組成地址通知信件
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

// 📡 接收地址變動 Webhook
app.post("/webhook", async (req, res) => {
  const customer = req.body;
  const id = customer.id.toString();

  const addresses = customer.addresses || [];
  const defaultAddress = customer.default_address || null;
  const extraAddresses = addresses.filter(a => a.id !== defaultAddress?.id);

  const defaultHash = hashAddresses(defaultAddress ? [defaultAddress] : []);
  const extraHash = hashAddresses(extraAddresses);

  const isFirstTime = !customerStore[id];
  const last = customerStore[id] || { defaultHash: "", extraHash: "" };
  const defaultChanged = last.defaultHash !== defaultHash;
  const extraChanged = last.extraHash !== extraHash;

  let action = null;

  if (isFirstTime) {
    // 註冊後第一次傳入，忽略（不通知）
    customerStore[id] = { defaultHash, extraHash };
    return res.send("✅ 新帳戶初次傳入，略過通知");
  }

  if (!last.defaultHash && defaultHash) action = "加入預設地址";
  else if (last.defaultHash && !defaultHash) action = "刪除預設地址";
  else if (defaultChanged) action = "變更預設地址";
  else if (!last.extraHash && extraHash) action = "新增地址";
  else if (last.extraHash && !extraHash) action = "刪除地址";
  else if (extraChanged) action = "更新地址";
  else return res.send("✅ 無地址變更");

  customerStore[id] = { defaultHash, extraHash };

  const body = formatEmailBody(customer, action);
  try {
    await sendNotification({
      toAdmin: true,
      toCustomer: false, // ✅ 只寄公司
      customer,
      subject: `📢 客戶地址${action}`,
      body
    });
    res.send(`📨 已寄出通知：${action}`);
  } catch (err) {
    res.status(500).send("❌ 郵件寄送失敗");
  }
});

// 🗑️ 刪除帳戶
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
    await sendNotification({
      toAdmin: true,
      toCustomer: true,
      customer: { email },
      subject: "🗑️ 有客戶刪除帳戶",
      body: msg_to_admin
    });

    await sendNotification({
      toAdmin: false,
      toCustomer: true,
      customer: { email },
      subject: "✅ 您的帳戶已成功刪除",
      body: msg_to_user
    });

    res.send("✅ 已通知雙方帳戶刪除成功");
  } catch (err) {
    res.status(500).send("❌ 刪除通知失敗");
  }
});

// 🆕 客戶註冊通知
app.post("/webhook/new-customer", async (req, res) => {
  const { email, first_name, last_name } = req.body;
  const time = DateTime.now().setZone("Asia/Hong_Kong").toFormat("yyyy/MM/dd HH:mm:ss");

  const msg = `🆕 有新客戶註冊：

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
    res.send("✅ 公司已收到註冊通知");
  } catch (err) {
    res.status(500).send("❌ 註冊通知發送失敗");
  }
});

app.get("/", (req, res) => {
  res.send("✅ Webhook 伺服器正常運行");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`📡 Webhook 啟動於 http://localhost:${PORT}`);
});

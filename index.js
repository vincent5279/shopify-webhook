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
  }).then(() => {
    console.log(`📨 成功寄出：${action}`);
    res.send(`📨 已寄出通知：${action}`);
  }).catch(err => {
    console.error("❌ 寄信錯誤：", err);
    res.status(500).send("❌ 郵件發送失敗");
  });
}

app.post("/webhook", (req, res) => {
  const customer = req.body;
  const id = customer.id.toString();

  console.log(`📥 Webhook 收到來自客戶 #${id}`);

  const addresses = customer.addresses || [];
  const defaultAddress = customer.default_address || null;
  const extraAddresses = addresses.filter(a => a.id !== defaultAddress?.id);

  const defaultHash = hashAddresses(defaultAddress ? [defaultAddress] : []);
  const extraHash = hashAddresses(extraAddresses);

  const last = customerStore[id] || { defaultHash: "", extraHash: "" };
  let action = null;

  // ✅ 加入判斷，避免第一次誤發「加入預設地址」
  const isFirstTime = !customerStore[id];
  const defaultChanged = last.defaultHash !== defaultHash;
  const extraChanged = last.extraHash !== extraHash;

  if (isFirstTime && !defaultChanged && !extraChanged) {
    console.log("✅ 第一次 webhook，無地址變更");
    return res.send("✅ 第一次無地址變更，略過");
  }
  
  if (!isFirstTime && !last.defaultHash && defaultHash) {
    action = "加入預設地址";
  } else if (!isFirstTime && last.defaultHash && !defaultHash) {
    action = "刪除預設地址";
  } else if (defaultChanged) {
    action = "變更預設地址";
  } else if (!last.extraHash && extraHash) {
    action = "新增地址";
  } else if (last.extraHash && !extraHash) {
    action = "刪除地址";
  } else if (extraChanged) {
    action = "更新地址";
  } else {
    console.log("✅ 無地址變更");
    return res.send("✅ 無地址變更");
  }  

  console.log(`🔍 判斷結果：${action}`);
  customerStore[id] = { defaultHash, extraHash };
  return sendNotification(customer, action, res);
});

// 🗑️ 刪除帳戶處理（清除記憶並發通知信）
app.post("/delete-account", (req, res) => {
  const { id, email, first_name, last_name } = req.body;

  if (!id || !email) {
    return res.status(400).send("❌ 缺少必要欄位（id 或 email）");
  }

  // 1️⃣ 刪除記憶資料
  if (customerStore[id]) {
    delete customerStore[id];
    console.log(`🧹 已刪除記憶資料 for 客戶 #${id}`);
  } else {
    console.log(`ℹ️ 無需刪除，客戶 #${id} 無記憶資料`);
  }

  // 2️⃣ 發送帳戶刪除通知
  const createdAt = DateTime.now().setZone("Asia/Hong_Kong").toFormat("yyyy/MM/dd HH:mm:ss");

  const msg = `👋 ${first_name || ""} ${last_name || ""} 您好，

您已成功刪除 Shopify 帳戶。
我們已於 ${createdAt}（香港時間）移除與您相關的所有地址通知記錄與系統記憶。

🧠 所有紀錄已被永久清除，若您日後重新註冊，我們將視為全新帳戶。

謝謝您曾使用我們的服務 🙏`;

  transporter.sendMail({
    from: process.env.EMAIL_USER,
    to: email,
    subject: "✅ 您的帳戶資料已刪除",
    text: msg
  }).then(() => {
    console.log(`📨 已通知 ${email}：帳戶已刪除`);
    res.send("✅ 帳戶資料已刪除並通知用戶");
  }).catch(err => {
    console.error("❌ 寄信失敗：", err);
    res.status(500).send("❌ 通知寄出失敗");
  });
});

app.get("/", (req, res) => {
  res.send("✅ Webhook 伺服器正在運行。請使用 POST /webhook 傳送 Shopify 客戶資料。");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`📡 Webhook 啟動於 http://localhost:${PORT}`);
});

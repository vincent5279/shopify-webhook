// 📦 Shopify 客戶通知系統（繁體中文 + 每次註冊通知 + 地址變動通知 + 單次刪除通知 + 中英文姓名顯示）

const express = require("express");
const crypto = require("crypto");
const { DateTime } = require("luxon");
const nodemailer = require("nodemailer");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const customerStore = {}; // { [customerId]: { notified, defaultHash, extraHash }, deleted_id: true }

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER || "takshing78@gmail.com",
    pass: process.env.EMAIL_PASS || "whfa ugtr frbg tujw"
  }
});

// 🧠 顯示中英文姓名
function formatFullName(first, last) {
  const isChinese = str => /[\u4e00-\u9fff]/.test(str);
  if (!first && !last) return "";
  return isChinese(first) || isChinese(last) ? `${last}${first}` : `${first} ${last}`;
}

// ✅ 對地址欄位所有欄位做 hash
function hashAddressFields(address) {
  if (!address) return "";
  const fields = [
    address.first_name,
    address.last_name,
    address.name,
    address.company,
    address.address1,
    address.address2,
    address.city,
    address.province,
    address.zip,
    address.country,
    address.phone
  ];
  return crypto.createHash("sha256").update(fields.join("|").toLowerCase()).digest("hex");
}

function hashAddresses(addresses) {
  if (!addresses || addresses.length === 0) return "";
  const content = addresses.map(hashAddressFields).join("|");
  return crypto.createHash("sha256").update(content).digest("hex");
}

// ✉️ 寄信
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

// 🆕 新客戶註冊通知
app.post("/webhook/new-customer", async (req, res) => {
  const { id, email, first_name, last_name, name, default_address, addresses } = req.body;
  const customerId = id?.toString();
  if (!customerId) return res.status(400).send("❌ 缺少 customer ID");

  const displayName = name || formatFullName(first_name, last_name);
  const time = DateTime.now().setZone("Asia/Hong_Kong").toFormat("yyyy/MM/dd HH:mm:ss");

  const msg = `🆕 有新客戶註冊帳號：

👤 帳號姓名：${displayName}
📧 電郵：${email}
🕒 註冊時間：${time}（香港時間）`;

  try {
    await sendNotification({
      toAdmin: true,
      toCustomer: false,
      subject: "🆕 有新客戶註冊帳號",
      body: msg
    });

    customerStore[customerId] = {
      notified: true,
      defaultHash: hashAddresses(default_address ? [default_address] : []),
      extraHash: hashAddresses((addresses || []).filter(a => a.id !== default_address?.id))
    };

    delete customerStore[`deleted_${customerId}`];
    res.send("✅ 公司已收到註冊通知");
  } catch (err) {
    console.error("❌ 註冊通知寄送失敗", err);
    res.status(500).send("❌ 寄送失敗");
  }
});

// 📮 地址變更通知
app.post("/webhook", async (req, res) => {
  const customer = req.body;
  const customerId = customer.id?.toString();
  if (!customerId) return res.status(400).send("❌ 缺少 customer ID");

  const addresses = customer.addresses || [];
  const defaultAddress = customer.default_address || null;
  const extraAddresses = addresses.filter(a => a.id !== defaultAddress?.id);

  const defaultHash = hashAddresses(defaultAddress ? [defaultAddress] : []);
  const extraHash = hashAddresses(extraAddresses);

  const last = customerStore[customerId];

  if (!last) {
    customerStore[customerId] = { defaultHash, extraHash, notified: true };
    return res.send("✅ 首次登入，僅記錄地址 hash");
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
    customerStore[customerId] = { ...last, defaultHash, extraHash };
    return res.send("✅ 無地址變更");
  }

  customerStore[customerId] = { ...last, defaultHash, extraHash };

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

// 🗑️ 刪除帳戶通知
app.post("/delete-account", async (req, res) => {
  const { id, email, first_name, last_name } = req.body;
  const customerId = id?.toString();
  if (!customerId || !email) return res.status(400).send("❌ 缺少帳戶 ID 或 Email");

  const deletedKey = `deleted_${customerId}`;
  if (customerStore[deletedKey]) {
    return res.send("✅ 該帳戶已寄送刪除通知");
  }

  const time = DateTime.now().setZone("Asia/Hong_Kong").toFormat("yyyy/MM/dd HH:mm:ss");
  const msg = `👋 ${formatFullName(first_name, last_name)} 您好，

您已成功刪除本公司網站帳戶。
我們已於 ${time}（香港時間）清除與您相關的通知記錄與記憶。

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

    delete customerStore[customerId];
    customerStore[deletedKey] = true;

    res.send("✅ 已寄送刪除確認信給用戶");
  } catch (err) {
    console.error("❌ 刪除信寄送失敗", err);
    res.status(500).send("❌ 發送刪除確認信失敗");
  }
});

// 📧 電郵內容格式化
function formatEmailBody(customer, action) {
  const createdAt = DateTime.now().setZone("Asia/Hong_Kong").toFormat("yyyy/MM/dd HH:mm:ss");
  const accountName = customer.name || formatFullName(customer.first_name, customer.last_name);

  let body = `📬 客戶地址${action}通知\n`;
  body += `──────────────────\n`;
  body += `👤 帳號姓名：${accountName}\n`;
  body += `📧 電郵：${customer.email}\n`;
  body += `🗓️ 通知寄出時間：${createdAt}（香港時間）\n`;
  body += `──────────────────\n\n`;

  const addresses = customer.addresses || [];
  if (addresses.length === 0) {
    body += `🏠 地址列表：目前無任何地址\n`;
  } else {
    body += `🏠 地址列表：共 ${addresses.length} 筆\n`;
    addresses.forEach((addr, i) => {
      const contactName = formatFullName(addr.first_name || "", addr.last_name || "") || addr.name || "未提供";
      body += `\n【地址 ${i + 1}】──────────────────\n`;
      body += `👤 收件聯繫人姓名：${contactName}\n`;
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

// 📦 Shopify 客戶通知系統（繁體中文 + 註冊/地址通知 + 單次刪除 + 中英文姓名顯示 + 無 SQLite）

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { DateTime } = require("luxon");
const nodemailer = require("nodemailer");

const app = express();
app.use(cors());
app.use(express.json());

// 🧠 客戶記憶體資料儲存（模擬同步狀態）
const customerStore = {}; // key: customer.id, value: 資料物件
const deletedTracker = {}; // 防止重複通知刪除

// ✉️ 設定郵件發送器
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
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

function formatFullName(first, last) {
  const isChinese = str => /[\u4e00-\u9fff]/.test(str);
  if (!first && !last) return "";
  return isChinese(first) || isChinese(last) ? `${last}${first}` : `${first} ${last}`;
}

// ✅ 嚴格比對重要地址欄位（解決登入誤觸）
function compareAddress(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return (
    a.address1 === b.address1 &&
    a.city === b.city &&
    a.province === b.province &&
    a.zip === b.zip &&
    a.country === b.country
  );
}

// ✅ 註冊通知
app.post("/webhook/new-customer", async (req, res) => {
  const { id, email, first_name, last_name, default_address, addresses } = req.body;
  const customerId = id?.toString();
  if (!customerId) return res.status(400).send("❌ 缺少 customer ID");

  const displayName = formatFullName(first_name, last_name);
  const time = DateTime.now().setZone("Asia/Hong_Kong").toFormat("yyyy/MM/dd HH:mm:ss");

  const msg = `🆕 有新客戶註冊帳號：\n\n👤 帳號姓名：${displayName}\n📧 電郵：${email}\n🕒 註冊時間：${time}（香港時間）`;

  try {
    await sendNotification({ toAdmin: true, subject: "🆕 有新客戶註冊帳號", body: msg });

    customerStore[customerId] = {
      id: customerId,
      name: displayName,
      email,
      default_address,
      extra_addresses: (addresses || []).filter(a => a.id !== default_address?.id),
      updated_at: time
    };

    delete deletedTracker[customerId];
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

  const last = customerStore[customerId];
  const defaultAddress = customer.default_address || null;
  const addresses = customer.addresses || [];
  const extraAddresses = addresses.filter(a => a.id !== defaultAddress?.id);

  if (!last) {
    customerStore[customerId] = {
      id: customerId,
      name: formatFullName(customer.first_name, customer.last_name),
      email: customer.email,
      default_address: defaultAddress,
      extra_addresses: extraAddresses,
      updated_at: DateTime.now().toISO()
    };
    return res.send("✅ 首次記錄地址，不發送通知");
  }

  let action = null;
  const sameDefault = compareAddress(last.default_address, defaultAddress); // ✅ 改用安全比對
  const sameExtra = JSON.stringify(last.extra_addresses) === JSON.stringify(extraAddresses);

  if (!sameDefault) {
    if (!last.default_address && defaultAddress) action = "加入預設地址";
    else if (last.default_address && !defaultAddress) action = "刪除預設地址";
    else action = "變更預設地址";
  }

  if (!sameExtra) {
    const oldCount = last.extra_addresses.length;
    const newCount = extraAddresses.length;
    if (newCount > oldCount) action = "新增地址";
    else if (newCount < oldCount) action = "刪除地址";
    else action = "更新地址";
  }

  if (!action) {
    return res.send("✅ 地址無變更");
  }

  customerStore[customerId] = {
    ...last,
    default_address: defaultAddress,
    extra_addresses: extraAddresses,
    updated_at: DateTime.now().toISO()
  };

  const time = DateTime.now().setZone("Asia/Hong_Kong").toFormat("yyyy/MM/dd HH:mm:ss");
  let body = `📬 客戶地址${action}通知\n`;
  body += `──────────────────\n`;
  body += `👤 帳號姓名：${last.name}\n`;
  body += `📧 電郵：${last.email}\n`;
  body += `🗓️ 通知寄出時間：${time}（香港時間）\n\n`;
  body += `🏠 地址列表：共 ${addresses.length} 筆\n`;

  addresses.forEach((addr, i) => {
    const contact = formatFullName(addr.first_name || "", addr.last_name || "") || addr.name || "未提供";
    body += `\n【地址 ${i + 1}】──────────────────\n`;
    body += `👤 收件聯繫人姓名：${contact}\n`;
    body += `🏢 公司：${addr.company || "未提供"}\n`;
    body += `📍 地址一：${addr.address1 || "未提供"}\n`;
    body += `📍 地址二：${addr.address2 || "未提供"}\n`;
    body += `🏙️ 城市：${addr.city || "未提供"}\n`;
    body += `🏞️ 省份：${addr.province || "未提供"}\n`;
    body += `🌍 國家：${addr.country || "未提供"}\n`;
    body += `📞 電話：${addr.phone || "未提供"}\n`;
  });

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
    console.error("❌ 郵件寄送失敗", err);
    res.status(500).send("❌ 郵件寄送失敗");
  }
});

// 🗑️ 刪除帳戶通知
app.post("/delete-account", async (req, res) => {
  const { id, email, first_name, last_name } = req.body;
  const customerId = id?.toString();
  if (!customerId || !email) return res.status(400).send("❌ 缺少帳戶 ID 或 Email");

  if (deletedTracker[customerId]) return res.send("✅ 該帳戶已寄送刪除通知");

  const time = DateTime.now().setZone("Asia/Hong_Kong").toFormat("yyyy/MM/dd HH:mm:ss");
  const displayName = formatFullName(first_name, last_name);

  const msg = `👋 ${displayName} 您好，

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
    deletedTracker[customerId] = true;

    res.send("✅ 已寄送刪除確認信給用戶");
  } catch (err) {
    console.error("❌ 刪除通知寄送失敗", err);
    res.status(500).send("❌ 發送刪除確認信失敗");
  }
});

// ✅ 健康檢查
app.get("/", (req, res) => {
  res.send("✅ Webhook 伺服器正常運行");
});

// 🧾 測試用：查看記憶體資料
app.get("/customers", (req, res) => {
  res.json(Object.values(customerStore));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`📡 Webhook 啟動於 http://localhost:${PORT}`);
});

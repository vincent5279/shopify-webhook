// 📦 Shopify 客戶通知系統（繁體中文 + 註冊/地址通知 + 單次刪除 + 中英文姓名顯示 + SQLite 加密持久化）

require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { DateTime } = require("luxon");
const nodemailer = require("nodemailer");
const cors = require("cors");
const Database = require("better-sqlite3");

const app = express();
app.use(cors());
app.use(express.json());

// ✅ 自動建立資料夾
const dbDir = path.join(__dirname, "data");
const dbPath = path.join(dbDir, "customer_store.db");
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir);

// 🔐 加密密鑰
const secret = process.env.SECRET_KEY;
function encrypt(text) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", Buffer.from(secret), iv);
  const encrypted = Buffer.concat([cipher.update(text), cipher.final()]);
  return iv.toString("hex") + ":" + encrypted.toString("hex");
}
function decrypt(text) {
  const [ivHex, encryptedHex] = text.split(":");
  const iv = Buffer.from(ivHex, "hex");
  const encryptedText = Buffer.from(encryptedHex, "hex");
  const decipher = crypto.createDecipheriv("aes-256-cbc", Buffer.from(secret), iv);
  const decrypted = Buffer.concat([decipher.update(encryptedText), decipher.final()]);
  return decrypted.toString();
}

// ✅ 初始化 SQLite
const db = new Database(dbPath);
db.exec(`
  CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY,
    name TEXT,
    email TEXT,
    default_address TEXT,
    extra_addresses TEXT,
    defaultHash TEXT,
    extraHash TEXT,
    updated_at TEXT
  );
`);

function getCustomer(id) {
  try {
    const row = db.prepare("SELECT * FROM customers WHERE id = ?").get(id);
    if (!row) return null;
    return {
      ...row,
      name: decrypt(row.name),
      email: decrypt(row.email),
      default_address: JSON.parse(decrypt(row.default_address)),
      extra_addresses: JSON.parse(decrypt(row.extra_addresses))
    };
  } catch (err) {
    console.error("❌ 讀取客戶資料失敗", err);
    return null;
  }
}

function setCustomer({ id, name, email, default_address, extra_addresses, defaultHash, extraHash }) {
  const now = DateTime.now().toISO();
  try {
    db.prepare(`
      INSERT INTO customers (id, name, email, default_address, extra_addresses, defaultHash, extraHash, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        email = excluded.email,
        default_address = excluded.default_address,
        extra_addresses = excluded.extra_addresses,
        defaultHash = excluded.defaultHash,
        extraHash = excluded.extraHash,
        updated_at = excluded.updated_at;
    `).run(
      id,
      encrypt(name),
      encrypt(email),
      encrypt(JSON.stringify(default_address)),
      encrypt(JSON.stringify(extra_addresses)),
      defaultHash,
      extraHash,
      now
    );
  } catch (err) {
    console.error("❌ 寫入 SQLite 資料失敗", err);
  }
}

function deleteCustomer(id) {
  try {
    db.prepare("DELETE FROM customers WHERE id = ?").run(id);
  } catch (err) {
    console.error("❌ 刪除客戶資料失敗", err);
  }
}

function formatFullName(first, last) {
  const isChinese = str => /[\u4e00-\u9fff]/.test(str);
  if (!first && !last) return "";
  return isChinese(first) || isChinese(last) ? `${last}${first}` : `${first} ${last}`;
}

function hashAddressFields(address) {
  if (!address) return "";
  const fields = [
    address.first_name, address.last_name, address.name, address.company,
    address.address1, address.address2, address.city, address.province,
    address.zip, address.country, address.phone
  ];
  return crypto.createHash("sha256").update(fields.join("|").toLowerCase()).digest("hex");
}
function hashAddresses(addresses) {
  if (!addresses || addresses.length === 0) return "";
  const content = addresses.map(hashAddressFields).join("|");
  return crypto.createHash("sha256").update(content).digest("hex");
}

const customerStore = {};

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

// 🆕 註冊通知
app.post("/webhook/new-customer", async (req, res) => {
  const { id, email, first_name, last_name, name, default_address, addresses } = req.body;
  const customerId = id?.toString();
  if (!customerId) return res.status(400).send("❌ 缺少 customer ID");

  const displayName = name || formatFullName(first_name, last_name);
  const time = DateTime.now().setZone("Asia/Hong_Kong").toFormat("yyyy/MM/dd HH:mm:ss");

  const msg = `🆕 有新客戶註冊帳號：\n\n👤 帳號姓名：${displayName}\n📧 電郵：${email}\n🕒 註冊時間：${time}（香港時間）`;

  try {
    await sendNotification({ toAdmin: true, subject: "🆕 有新客戶註冊帳號", body: msg });

    const defaultHash = hashAddresses(default_address ? [default_address] : []);
    const extraAddresses = (addresses || []).filter(a => a.id !== default_address?.id);
    const extraHash = hashAddresses(extraAddresses);

    setCustomer({
      id: customerId,
      name: displayName,
      email,
      default_address,
      extra_addresses: extraAddresses,
      defaultHash,
      extraHash
    });

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

  const defaultAddress = customer.default_address || null;
  const addresses = customer.addresses || [];
  const extraAddresses = addresses.filter(a => a.id !== defaultAddress?.id);

  const defaultHash = hashAddresses(defaultAddress ? [defaultAddress] : []);
  const extraHash = hashAddresses(extraAddresses);

  const last = getCustomer(customerId);
  if (!last) {
    setCustomer({
      id: customerId,
      name: customer.name || formatFullName(customer.first_name, customer.last_name),
      email: customer.email,
      default_address: defaultAddress,
      extra_addresses: extraAddresses,
      defaultHash,
      extraHash
    });
    return res.send("✅ 首次記錄地址，不發送通知");
  }

  const defaultChanged = last.defaultHash !== defaultHash;
  const extraChanged = last.extraHash !== extraHash;

  let action = null;
  if (!last.defaultHash && defaultHash) action = "加入預設地址";
  else if (last.defaultHash && !defaultHash) action = "刪除預設地址";
  else if (defaultChanged) action = "變更預設地址";

  if (extraChanged) {
    const oldCount = last.extra_addresses.length;
    const newCount = extraAddresses.length;
    if (newCount > oldCount) action = "新增地址";
    else if (newCount < oldCount) action = "刪除地址";
    else action = "更新地址";
  }

  if (!action) {
    setCustomer({
      id: customerId,
      name: last.name,
      email: last.email,
      default_address: defaultAddress,
      extra_addresses: extraAddresses,
      defaultHash,
      extraHash
    });
    return res.send("✅ 地址無變更");
  }

  setCustomer({
    id: customerId,
    name: last.name,
    email: last.email,
    default_address: defaultAddress,
    extra_addresses: extraAddresses,
    defaultHash,
    extraHash
  });

  const time = DateTime.now().setZone("Asia/Hong_Kong").toFormat("yyyy/MM/dd HH:mm:ss");
  let body = `📬 客戶地址${action}通知\n`;
  body += `──────────────────\n`;
  body += `👤 帳號姓名：${last.name}\n`;
  body += `📧 電郵：${last.email}\n`;
  body += `🗓️ 通知寄出時間：${time}（香港時間）\n`;
  body += `──────────────────\n\n`;
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

  const deletedKey = `deleted_${customerId}`;
  if (customerStore[deletedKey]) return res.send("✅ 該帳戶已寄送刪除通知");

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

    deleteCustomer(customerId);
    customerStore[deletedKey] = true;

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

// ✅ 下載資料庫
app.get("/download-db", (req, res) => {
  const token = req.query.token;
  if (token !== process.env.DOWNLOAD_TOKEN) {
    return res.status(403).send("🚫 無效的下載 Token");
  }

  fs.access(dbPath, fs.constants.F_OK, (err) => {
    if (err) return res.status(404).send("❌ 找不到資料庫");

    res.download(dbPath, "customer_store.db", (err) => {
      if (err) {
        console.error("❌ 下載失敗", err);
        res.status(500).send("❌ 下載失敗");
      }
    });
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`📡 Webhook 啟動於 http://localhost:${PORT}`);
});

// 📦 Shopify 客戶通知系統（繁體中文 + 註冊/地址通知 + 單次刪除 + 中英文姓名顯示 + SQLite 加密持久化）

require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const { DateTime } = require("luxon");
const nodemailer = require("nodemailer");
const cors = require("cors");
const Database = require("better-sqlite3");

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

// ✅ 初始化 SQLite 資料表（包含加密資料）
const db = new Database("customer_store.db");
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
  const row = db.prepare("SELECT * FROM customers WHERE id = ?").get(id);
  if (!row) return null;
  return {
    ...row,
    name: decrypt(row.name),
    email: decrypt(row.email),
    default_address: JSON.parse(decrypt(row.default_address)),
    extra_addresses: JSON.parse(decrypt(row.extra_addresses))
  };
}
function setCustomer({ id, name, email, default_address, extra_addresses, defaultHash, extraHash }) {
  const now = DateTime.now().toISO();
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
}
function deleteCustomer(id) {
  db.prepare("DELETE FROM customers WHERE id = ?").run(id);
}

// 🧠 顯示中英文姓名
function formatFullName(first, last) {
  const isChinese = str => /[\u4e00-\u9fff]/.test(str);
  if (!first && !last) return "";
  return isChinese(first) || isChinese(last) ? `${last}${first}` : `${first} ${last}`;
}

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

const app = express();
app.use(cors());
app.use(express.json());

const customerStore = {}; // 僅用來記錄刪除狀態

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

// 🆕 新客戶註冊通知
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

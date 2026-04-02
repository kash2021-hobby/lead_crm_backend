require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Sequelize, DataTypes, Op } = require('sequelize');
const cron = require('node-cron');
const { google } = require('googleapis');
// --- SECURITY IMPORTS ---
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_key_change_me';

// Initialize Sequelize (MySQL)
const sequelize = new Sequelize(
  process.env.DB_NAME,
  process.env.DB_USER,
  process.env.DB_PASS,
  {
    host: process.env.DB_HOST,
    dialect: 'mysql',
    logging: false,
  }
);

// --- MODELS ---

const User = sequelize.define('User', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  username: { type: DataTypes.STRING, allowNull: false, unique: true },
  password: { type: DataTypes.STRING, allowNull: false }, 
});

const Campaign = sequelize.define('Campaign', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  name: { type: DataTypes.STRING, allowNull: false },
  sheet_id: { type: DataTypes.STRING, allowNull: false, unique: true },
});

const Lead = sequelize.define('Lead', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  name: { type: DataTypes.STRING, allowNull: true },
  phone: { type: DataTypes.STRING, allowNull: false, unique: true },
  email: { type: DataTypes.STRING, allowNull: true },
  source_sheet_id: { type: DataTypes.STRING, allowNull: false },
  status: { type: DataTypes.ENUM('new', 'contacted', 'followup', 'converted'), defaultValue: 'new' },
  notes: { type: DataTypes.TEXT, allowNull: true }, 
  details: { type: DataTypes.JSON, allowNull: true }, 
  reminder_date: { type: DataTypes.DATE, allowNull: true },
  reminder_sent: { type: DataTypes.BOOLEAN, defaultValue: false },
});

const Activity = sequelize.define('Activity', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  type: { type: DataTypes.ENUM('call', 'message', 'meeting', 'note', 'system'), allowNull: false },
  content: { type: DataTypes.TEXT, allowNull: false },
});

Campaign.hasMany(Lead, { foreignKey: 'campaign_id', onDelete: 'CASCADE' });
Lead.belongsTo(Campaign, { foreignKey: 'campaign_id' });
Lead.hasMany(Activity, { foreignKey: 'lead_id', onDelete: 'CASCADE' });
Activity.belongsTo(Lead, { foreignKey: 'lead_id' });

// --- UTILS ---
const logInfo = (msg) => console.log(`[INFO] ${new Date().toISOString()} - ${msg}`);
const logError = (msg, err) => console.error(`[ERROR] ${new Date().toISOString()} - ${msg}`, err?.message || err);

const normalizeData = (rows) => {
  if (!rows || rows.length < 2) return [];
  const headers = rows[0].map(h => h.toLowerCase().trim());
  const leads = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const rowData = {};
    headers.forEach((h, idx) => { rowData[h] = row[idx] || ''; });
    let phone = (rowData['phone'] || rowData['phone_number'] || '').replace(/\D/g, ''); 
    let name = rowData['full_name'] || rowData['first_name'] || rowData['name'] || 'Unknown';
    if (phone && phone.length >= 10) {
      leads.push({ name, phone, email: rowData['email'] || null, details: rowData });
    }
  }
  return leads;
};

// --- GOOGLE SHEETS & CRON ---

let authOptions = {
  scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
};

// Railway Deployment Fix: Use Environment Variable if it exists, otherwise use local file
if (process.env.GOOGLE_CREDENTIALS) {
  try {
    authOptions.credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  } catch (err) {
    logError("Failed to parse GOOGLE_CREDENTIALS environment variable. Make sure it is valid JSON.", err);
  }
} else {
  authOptions.keyFile = './google-credentials.json';
}

const auth = new google.auth.GoogleAuth(authOptions);
const sheets = google.sheets({ version: 'v4', auth });

const fetchAndSyncLeads = async () => {
  try {
    const campaigns = await Campaign.findAll();
    for (const campaign of campaigns) {
      const response = await sheets.spreadsheets.values.get({ spreadsheetId: campaign.sheet_id, range: 'Sheet1!A:Z' });
      const normalizedLeads = normalizeData(response.data.values);
      for (const leadData of normalizedLeads) {
        const exists = await Lead.findOne({ where: { phone: leadData.phone } });
        if (!exists) {
          const newLead = await Lead.create({ ...leadData, source_sheet_id: campaign.sheet_id, campaign_id: campaign.id });
          await Activity.create({ lead_id: newLead.id, type: 'system', content: 'Client added to CRM via Sheets Integration' });
        }
      }
    }
  } catch (dbErr) { logError("Database/Sheets error during sync", dbErr); }
};

const checkReminders = async () => {
  try {
    const now = new Date();
    const dueLeads = await Lead.findAll({
      where: { status: 'followup', reminder_date: { [Op.lte]: now }, reminder_sent: false }
    });
    for (const lead of dueLeads) {
      lead.reminder_sent = true;
      await lead.save();
      await Activity.create({ lead_id: lead.id, type: 'system', content: 'Automated follow-up reminder triggered.' });
    }
  } catch (error) { logError("Reminder Check Error", error); }
};

cron.schedule('*/5 * * * *', fetchAndSyncLeads);
cron.schedule('* * * * *', checkReminders);

// --- AUTHENTICATION & MIDDLEWARE ---

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ where: { username } });
    if (!user) return res.status(401).json({ error: 'Invalid username or password' });

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) return res.status(401).json({ error: 'Invalid username or password' });

    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ success: true, token, username: user.username });
  } catch (error) {
    res.status(500).json({ error: "Login failed" });
  }
});

app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

    const existingUser = await User.findOne({ where: { username } });
    if (existingUser) return res.status(400).json({ error: 'Username exists' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = await User.create({ username, password: hashedPassword });

    res.status(201).json({ success: true, username: newUser.username });
  } catch (error) {
    res.status(500).json({ error: "Registration failed", details: error.message });
  }
});

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; 
  if (!token) return res.status(401).json({ error: 'Access denied.' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token.' });
    req.user = user; 
    next();
  });
};


// --- API ROUTES (PROTECTED) ---

app.post('/api/sync', authenticateToken, async (req, res) => {
  try { await fetchAndSyncLeads(); res.status(200).json({ message: "Sync complete" }); } 
  catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/campaigns', authenticateToken, async (req, res) => { res.json(await Campaign.findAll()); });

app.post('/api/campaigns', authenticateToken, async (req, res) => {
  try { const campaign = await Campaign.create(req.body); fetchAndSyncLeads(); res.status(201).json(campaign); } 
  catch (error) { res.status(500).json({ error: error.message }); }
});

app.delete('/api/campaigns/:id', authenticateToken, async (req, res) => {
  try {
    const campaignId = req.params.id;
    await Lead.destroy({ where: { campaign_id: campaignId } });
    await Campaign.destroy({ where: { id: campaignId } });
    res.json({ success: true, message: 'Campaign deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/leads', authenticateToken, async (req, res) => {
  const { campaign_id } = req.query;
  const whereClause = campaign_id ? { campaign_id } : {};
  res.json(await Lead.findAll({ where: whereClause, include: [Campaign], order: [['createdAt', 'DESC']] }));
});

app.patch('/api/leads/:id', authenticateToken, async (req, res) => {
  try {
    const { status, notes, reminder_date } = req.body;
    const lead = await Lead.findByPk(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    
    if (status) lead.status = status;
    if (notes !== undefined) lead.notes = notes; 
    if (reminder_date !== undefined) {
      lead.reminder_date = reminder_date;
      lead.reminder_sent = false;
    }
    await lead.save();
    res.json(lead);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/leads/:id/activities', authenticateToken, async (req, res) => {
  res.json(await Activity.findAll({ where: { lead_id: req.params.id }, order: [['createdAt', 'DESC']] }));
});

app.post('/api/leads/:id/activities', authenticateToken, async (req, res) => {
  try {
    const activity = await Activity.create({ lead_id: req.params.id, type: req.body.type, content: req.body.content });
    res.status(201).json(activity);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// --- INITIALIZE & START SERVER ---
const initializeAdminUser = async () => {
  try {
    const count = await User.count();
    if (count === 0) {
      logInfo("No users found. Creating default admin account...");
      const hashedPassword = await bcrypt.hash('admin123', 10);
      await User.create({ username: 'admin', password: hashedPassword });
      logInfo("Default User Created -> Username: admin | Password: admin123");
    }
  } catch (err) { logError("Failed to create default user", err); }
};

sequelize.authenticate().then(() => {
  sequelize.sync({ alter: true }).then(async () => { 
    await initializeAdminUser(); 
    app.listen(PORT, () => {
      logInfo(`Server running on port ${PORT}`);
    });
  });
});

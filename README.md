# **Kuttu Bot Session Generator**

[![Generate Pair Code](https://img.shields.io/badge/Generate%20Pair%20Code-Click%20Here-brightgreen?style=for-the-badge)](https://qrkuttubot-md.koyeb.app/)

---

### Quick Start

- **1) Create a free MongoDB Atlas cluster**
  [![MongoDB Atlas - Create Account](https://img.shields.io/badge/MongoDB%20Atlas-Create%20Cluster-47A248?logo=mongodb&logoColor=white)](https://www.mongodb.com/cloud/atlas)

- **2) Set the `MONGODB_URI` env var**
  Copy your connection string from Atlas and set it as an environment variable — do **not** hardcode it in any file.

```
MONGODB_URI=mongodb+srv://<user>:<password>@<cluster>.mongodb.net/?retryWrites=true&w=majority
```

- **3) Deploy to Render**
  [![Render - Deploy](https://img.shields.io/badge/Render-Deploy%20Web%20Service-46E3B7?logo=render&logoColor=white)](https://render.com)
- **4) Deploy to Koyeb**
  [![Koyeb - Deploy](https://img.shields.io/badge/Koyeb-Deploy%20Web%20Service-46E3B7?logo=Koyeb&logoColor=white)](https://koyeb.com)

---

### How it works

Scanning the QR code (or entering the pair code) links your WhatsApp, then this app:

1. Saves your session (`creds.json`) as a document in MongoDB, keyed by your phone number / WhatsApp JID.
2. A rescan **overwrites** the same document automatically — no orphaned old sessions pile up.
3. Sends you a short `SESSION_ID=KUTTU~<id>` in WhatsApp — paste that into your bot's env vars.
4. The bot (KuttuBot-MD) fetches the full session from MongoDB on every startup using that ID, since Heroku/Koyeb wipe the filesystem on every restart.

**Important:** the main bot deployment must use the **same** `MONGODB_URI` (same cluster/db) so it can find the session this app saved.

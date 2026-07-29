import { MongoClient } from 'mongodb';

// Needs env var: MONGODB_URI (same connection string used on the consumer
// bot side too — both sides must point at the same cluster/db).
const uri = process.env.MONGODB_URI;
let client;
let col;

async function getCollection() {
    if (col) return col;
    if (!uri) throw new Error('MONGODB_URI env var not set — cannot save session');
    client = new MongoClient(uri);
    await client.connect();
    col = client.db('kuttubot').collection('sessions');
    return col;
}

// Save/replace a session for this owner (phone number or WA JID).
// Upsert on _id = owner means a rescan automatically OVERWRITES the old doc —
// no orphaned old sessions left behind, no manual delete step needed.
// Returns the owner string itself — that IS the SESSION_ID token.
export const saveSession = async (owner, credsJson) => {
    const c = await getCollection();
    await c.updateOne(
        { _id: owner },
        { $set: { creds: credsJson, updatedAt: new Date() } },
        { upsert: true }
    );
    return owner;
};

// Fetch a session's creds.json content back by its owner/token
export const loadSession = async (owner) => {
    const c = await getCollection();
    const doc = await c.findOne({ _id: owner });
    if (!doc) throw new Error('No session found for that SESSION_ID');
    return doc.creds;
};

// Explicit delete, if ever needed (e.g. user wants to fully wipe their session)
export const deleteSession = async (owner) => {
    const c = await getCollection();
    await c.deleteOne({ _id: owner });
};

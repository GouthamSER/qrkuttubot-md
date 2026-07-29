import express from 'express';
import fs from 'fs';
import pino from 'pino';
import { makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore, Browsers, jidNormalizedUser, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { delay } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import qrcodeTerminal from 'qrcode-terminal';
import { saveSession } from './db.js';

const router = express.Router();

// In-memory map so the frontend can poll for "linked" status + get the SESSION_ID
// key -> { status: 'pending' | 'linked' | 'failed', sessionId?: string }
const linkStatus = new Map();
// key -> { sock, dirs } — tracks the live socket for each QR request so we can
// cleanly kill it when the frontend regenerates a fresh QR (prevents stale/duplicate sockets)
const activeSockets = new Map();

router.get('/status/:key', (req, res) => {
    const s = linkStatus.get(req.params.key);
    res.send(s || { status: 'unknown' });
});

router.get('/cancel/:key', (req, res) => {
    const key = req.params.key;
    const entry = activeSockets.get(key);
    if (entry) {
        try { entry.sock.end(new Error('cancelled by client')); } catch (e) {}
        removeFile(entry.dirs);
        activeSockets.delete(key);
    }
    linkStatus.delete(key);
    res.send({ ok: true });
});

// Function to remove files or directories
function removeFile(FilePath) {
    try {
        if (!fs.existsSync(FilePath)) return false;
        fs.rmSync(FilePath, { recursive: true, force: true });
        return true;
    } catch (e) {
        console.error('Error removing file:', e);
        return false;
    }
}

router.get('/', async (req, res) => {
    // Generate unique session for each request to avoid conflicts
    const sessionId = Date.now().toString() + Math.random().toString(36).substr(2, 9);
    const dirs = `./qr_sessions/session_${sessionId}`;
    linkStatus.set(sessionId, { status: 'pending' });
    // auto-expire the status entry so the map doesn't grow forever
    setTimeout(() => linkStatus.delete(sessionId), 5 * 60 * 1000);

    // Ensure qr_sessions directory exists
    if (!fs.existsSync('./qr_sessions')) {
        fs.mkdirSync('./qr_sessions', { recursive: true });
    }

    async function initiateSession() {
        // ✅ PERMANENT FIX: Create the session folder before anything
        if (!fs.existsSync(dirs)) fs.mkdirSync(dirs, { recursive: true });

        const { state, saveCreds } = await useMultiFileAuthState(dirs);

        try {
            const { version, isLatest } = await fetchLatestBaileysVersion();
            
            let qrGenerated = false;
            let responseSent = false;

            // QR Code handling logic
            const handleQRCode = async (qr) => {
                if (qrGenerated || responseSent) return;
                
                qrGenerated = true;
                console.log('🟢 QR Code Generated! Scan it with your WhatsApp app.');
                console.log('📋 Instructions:');
                console.log('1. Open WhatsApp on your phone');
                console.log('2. Go to Settings > Linked Devices');
                console.log('3. Tap "Link a Device"');
                console.log('4. Scan the QR code below');
                // Display QR in terminal
                //qrcodeTerminal.generate(qr, { small: true });
                try {
                    // Generate QR code as data URL
                    const qrDataURL = await QRCode.toDataURL(qr, {
                        errorCorrectionLevel: 'M',
                        type: 'image/png',
                        quality: 0.92,
                        margin: 1,
                        color: {
                            dark: '#000000',
                            light: '#FFFFFF'
                        }
                    });

                    if (!responseSent) {
                        responseSent = true;
                        console.log('QR Code generated successfully');
                        await res.send({ 
                            qr: qrDataURL, 
                            key: sessionId,
                            message: 'QR Code Generated! Scan it with your WhatsApp app.',
                            instructions: [
                                '1. Open WhatsApp on your phone',
                                '2. Go to Settings > Linked Devices',
                                '3. Tap "Link a Device"',
                                '4. Scan the QR code above'
                            ]
                        });
                    }
                } catch (qrError) {
                    console.error('Error generating QR code:', qrError);
                    if (!responseSent) {
                        responseSent = true;
                        res.status(500).send({ code: 'Failed to generate QR code' });
                    }
                }
            };

            // Improved Baileys socket configuration
            const socketConfig = {
                version,
                logger: pino({ level: 'silent' }),
                browser: Browsers.ubuntu('Chrome'), // matched with main bot fingerprint
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })),
                },
                markOnlineOnConnect: false, // Disable to reduce connection issues
                generateHighQualityLinkPreview: false, // Disable to reduce connection issues
                defaultQueryTimeoutMs: 60000, // Increase timeout
                connectTimeoutMs: 60000, // Increase connection timeout
                keepAliveIntervalMs: 30000, // Keep connection alive
                retryRequestDelayMs: 250, // Retry delay
                maxRetries: 5, // Maximum retries
            };

            // Create socket and bind events
            let sock = makeWASocket(socketConfig);
            activeSockets.set(sessionId, { sock, dirs });
            let reconnectAttempts = 0;
            const maxReconnectAttempts = 3;

            // Connection event handler function
            const handleConnectionUpdate = async (update) => {
                const { connection, lastDisconnect, qr } = update;
                console.log(`🔄 Connection update: ${connection || 'undefined'}`);

                if (qr && !qrGenerated) {
                    await handleQRCode(qr);
                }

                if (connection === 'open') {
                    console.log('✅ Connected successfully!');
                    console.log('💾 Session saved to:', dirs);
                    reconnectAttempts = 0; // Reset reconnect attempts on successful connection
                    
                    try {
                        
                        
                        // Get the user's JID from the session
                        const userJid = Object.keys(sock.authState.creds.me || {}).length > 0 
                            ? jidNormalizedUser(sock.authState.creds.me.id) 
                            : null;
                            
                        if (userJid) {
                            // Save creds.json into MongoDB (upsert on userJid = auto-overwrites old session)
                            const credsText = fs.readFileSync(dirs + '/creds.json', 'utf8');
                            const token = await saveSession(userJid, credsText);
                            const shortSessionId = `SESSION_ID=KUTTU~${token}`;
                            linkStatus.set(sessionId, { status: 'linked', sessionId: shortSessionId });
                            await sock.sendMessage(userJid, {
                                text: shortSessionId
                            });
                            console.log("📄 SESSION_ID sent successfully to", userJid);
                            
                            // Send video thumbnail with caption
                            await sock.sendMessage(userJid, {
                                image: { url: 'https://img.youtube.com/vi/-oz_u1iMgf8/maxresdefault.jpg' },
                                caption: `🎬 *KnightBot MD V2.0 Full Setup Guide!*\n\n🚀 Bug Fixes + New Commands + Fast AI Chat\n📺 Watch Now: https://youtu.be/NjOipI2AoMk`
                            });
                            console.log("🎬 Video guide sent successfully");
                            
                            // Send warning message
                            await sock.sendMessage(userJid, {
                                text: `⚠️ Do not share your SESSION_ID with anybody ⚠️\n
Copy the SESSION_ID above and paste it in your bot's environment variables.

┌┤✑  Thanks for using Knight Bot
│└────────────┈ ⳹        
│©2025 Goutham Josh 
└─────────────────┈ ⳹\n\n`
                            });
                        } else {
                            console.log("❌ Could not determine user JID to send session file");
                        }
                    } catch (error) {
                        console.error("Error sending session file:", error);
                        linkStatus.set(sessionId, { status: 'failed', reason: error.message });
                        // Don't leave a half-finished socket hanging around — it can
                        // cause WhatsApp "conflict" (401) errors if a reconnect fires next.
                        try { sock.end(error); } catch (e) {}
                        activeSockets.delete(sessionId);
                        removeFile(dirs);
                        return;
                    }
                    
                    // Clean up session after successful connection and sending files
                    setTimeout(() => {
                        console.log('🧹 Cleaning up session...');
                        const deleted = removeFile(dirs);
                        activeSockets.delete(sessionId);
                        if (deleted) {
                            console.log('✅ Session cleaned up successfully');
                        } else {
                            console.log('❌ Failed to clean up session folder');
                        }
                    }, 15000); // Wait 15 seconds before cleanup to ensure messages are sent
                }

                if (connection === 'close') {
                    console.log('❌ Connection closed');
                    if (lastDisconnect?.error) {
                        console.log('❗ Last Disconnect Error:', lastDisconnect.error);
                    }
                    
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    
                    // Handle specific error codes
                    if (statusCode === 401) {
                        console.log('🔐 Logged out - need new QR code');
                        linkStatus.set(sessionId, { status: 'failed' });
                        activeSockets.delete(sessionId);
                        removeFile(dirs);
                    } else if (statusCode === 515 || statusCode === 503) {
                        console.log(`🔄 Stream error (${statusCode}) - attempting to reconnect...`);
                        reconnectAttempts++;
                        
                        if (reconnectAttempts <= maxReconnectAttempts) {
                            console.log(`🔄 Reconnect attempt ${reconnectAttempts}/${maxReconnectAttempts}`);
                            // Wait a bit before reconnecting
                            setTimeout(() => {
                                try {
                                    sock = makeWASocket(socketConfig);
                                    activeSockets.set(sessionId, { sock, dirs });
                                    sock.ev.on('connection.update', handleConnectionUpdate);
                                    sock.ev.on('creds.update', saveCreds);
                                } catch (err) {
                                    console.error('Failed to reconnect:', err);
                                }
                            }, 2000);
                        } else {
                            console.log('❌ Max reconnect attempts reached');
                            if (!responseSent) {
                                responseSent = true;
                                res.status(503).send({ code: 'Connection failed after multiple attempts' });
                            }
                        }
                    } else {
                        console.log('🔄 Connection lost - attempting to reconnect...');
                        // Let it reconnect automatically
                    }
                }
            };

            // Bind the event handler
            sock.ev.on('connection.update', handleConnectionUpdate);

            sock.ev.on('creds.update', saveCreds);

            // Set a timeout to clean up if no QR is generated
            setTimeout(() => {
                if (!responseSent) {
                    responseSent = true;
                    res.status(408).send({ code: 'QR generation timeout' });
                    removeFile(dirs);
                }
            }, 30000); // 30 second timeout

        } catch (err) {
            console.error('Error initializing session:', err);
            if (!res.headersSent) {
                res.status(503).send({ code: 'Service Unavailable' });
            }
            removeFile(dirs);
        }
    }

    await initiateSession();
});

// Global uncaught exception handler
process.on('uncaughtException', (err) => {
    let e = String(err);
    if (e.includes("conflict")) return;
    if (e.includes("not-authorized")) return;
    if (e.includes("Socket connection timeout")) return;
    if (e.includes("rate-overlimit")) return;
    if (e.includes("Connection Closed")) return;
    if (e.includes("Timed Out")) return;
    if (e.includes("Value not found")) return;
    if (e.includes("Stream Errored")) return;
    if (e.includes("Stream Errored (restart required)")) return;
    if (e.includes("statusCode: 515")) return;
    if (e.includes("statusCode: 503")) return;
    console.log('Caught exception: ', err);
});

export default router;

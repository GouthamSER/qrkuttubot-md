import * as mega from 'megajs';

// Mega authentication credentials — MUST set MEGA_EMAIL / MEGA_PASSWORD env vars.
// If these are missing/wrong, mega login fails and megajs can throw internally
// in a way that never reaches our promise — the timeout below guards against that.
const auth = {
    email: process.env.MEGA_EMAIL,
    password: process.env.MEGA_PASSWORD,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/42.0.2311.135 Safari/537.36 Edge/12.246'
};

// Function to upload a file to Mega and return the URL
export const upload = (data, name) => {
    return new Promise((resolve, reject) => {
        if (!auth.email || !auth.password) {
            return reject(new Error('MEGA_EMAIL / MEGA_PASSWORD env vars are not set — cannot upload to Mega'));
        }

        let settled = false;
        const settle = (fn, arg) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            fn(arg);
        };

        // megajs can fail login internally without ever calling back or emitting
        // "error" (bad creds -> uncaught exception deep inside the lib). Without
        // this timeout the upload() promise hangs forever and the caller's
        // `await upload(...)` blocks indefinitely, which cascades into duplicate
        // sockets / WhatsApp "conflict" (401) errors down the line.
        const timer = setTimeout(() => {
            settle(reject, new Error('Mega upload timed out after 20s — check MEGA_EMAIL/MEGA_PASSWORD are correct'));
        }, 20000);

        try {
            const storage = new mega.Storage(auth, (err) => {
                if (err) return settle(reject, err);
                try {
                    const uploadStream = storage.upload({ name: name, allowUploadBuffering: true });
                    data.pipe(uploadStream);

                    storage.on("add", (file) => {
                        file.link((err, url) => {
                            if (err) return settle(reject, err);
                            storage.close();
                            settle(resolve, url);
                        });
                    });

                    storage.on("error", (error) => {
                        settle(reject, error);
                    });
                } catch (innerErr) {
                    settle(reject, innerErr);
                }
            });

            // covers login failures megajs surfaces via its own error event
            if (storage && typeof storage.on === 'function') {
                storage.on('error', (error) => settle(reject, error));
            }
        } catch (err) {
            settle(reject, err);
        }
    });
};

// Delete a previously uploaded file from Mega, given its share URL
export const remove = (url) => {
    return new Promise((resolve, reject) => {
        if (!url) return resolve(false);
        try {
            const file = mega.File.fromURL(url);
            file.loadAttributes((err) => {
                if (err) return reject(err);
                file.delete(true, (err) => { // true = delete permanently, skip trash
                    if (err) return reject(err);
                    resolve(true);
                });
            });
        } catch (err) {
            reject(err);
        }
    });
};
// Function to download a file from Mega using a URL
export const download = (url) => {
    return new Promise((resolve, reject) => {
        try {
            // Get file from Mega using the URL
            const file = mega.File.fromURL(url);

            file.loadAttributes((err) => {
                if (err) {
                    reject(err);
                    return;
                }

                // Download the file buffer
                file.downloadBuffer((err, buffer) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(buffer); // Return the file buffer
                    }
                });
            });
        } catch (err) {
            reject(err);
        }
    });
};

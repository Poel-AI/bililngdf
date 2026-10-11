const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
    let bits = 0;
    let value = 0;
    let out = '';
    for (const byte of buf) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            out += ALPHABET[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
    return out;
}

function base32Decode(str) {
    const clean = String(str || '').toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
    let bits = 0;
    let value = 0;
    const out = [];
    for (const ch of clean) {
        const idx = ALPHABET.indexOf(ch);
        if (idx < 0) continue;
        value = (value << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            out.push((value >>> (bits - 8)) & 255);
            bits -= 8;
        }
    }
    return Buffer.from(out);
}

function hotp(secretBuf, counter) {
    const msg = Buffer.alloc(8);
    msg.writeBigUInt64BE(BigInt(counter));
    const hmac = crypto.createHmac('sha1', secretBuf).update(msg).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const code =
        ((hmac[offset] & 0x7f) << 24) |
        ((hmac[offset + 1] & 0xff) << 16) |
        ((hmac[offset + 2] & 0xff) << 8) |
        (hmac[offset + 3] & 0xff);
    return String(code % 1000000).padStart(6, '0');
}

function totpAt(secretBase32, counter) {
    return hotp(base32Decode(secretBase32), counter);
}

function verifyTotp(secretBase32, token, window = 1) {
    const t = String(token || '').replace(/\s/g, '');
    if (!/^\d{6}$/.test(t)) return false;
    const counter = Math.floor(Date.now() / 1000 / 30);
    for (let w = -window; w <= window; w++) {
        const expected = totpAt(secretBase32, counter + w);
        const a = Buffer.from(expected);
        const b = Buffer.from(t);
        if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
    }
    return false;
}

function generateSecret() {
    return base32Encode(crypto.randomBytes(20));
}

function otpauthUrl(email, secret) {
    const issuer = 'Diet Fantasy';
    const label = encodeURIComponent(`${issuer}:${email}`);
    return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

module.exports = {
    base32Encode,
    base32Decode,
    hotp,
    totpAt,
    verifyTotp,
    generateSecret,
    otpauthUrl,
};

process.env.PORTAL_MODE = '1';
if (!process.env.PORTAL_BIND) process.env.PORTAL_BIND = '127.0.0.1';
if (process.env.PORTAL_COOKIE_SECURE == null) process.env.PORTAL_COOKIE_SECURE = '0';
require('../src/server.js');

import { Hono } from 'hono';
const app = new Hono();

import result from '../model/result';
import { cors } from 'hono/cors';

app.use('*', async (c, next) => {
	c.header('X-Content-Type-Options', 'nosniff');
	c.header('Referrer-Policy', 'no-referrer-when-downgrade');
	c.header('X-Frame-Options', 'DENY');
	c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
	await next();
});

app.use('*', cors({
	origin: (origin, c) => {
		const configured = c.env?.cors_origin || c.env?.CORS_ORIGIN || '';

		if (!configured) {
			return origin || '*';
		}

		if (configured === '*') {
			return origin || '*';
		}

		const allowList = configured.split(',').map(item => item.trim()).filter(Boolean);
		return allowList.includes(origin) ? origin : '';
	},
	allowHeaders: ['Content-Type', 'Authorization', 'accept-language'],
	allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
	maxAge: 86400,
}));

app.onError((err, c) => {
	if (err.name === 'BizError') {
		console.log(err.message);
	} else {
		console.error(err);
	}

	if (err.message === `Cannot read properties of undefined (reading 'get')`) {
		return c.json(result.fail('KV数据库未绑定 KV database not bound',502));
	}

	if (err.message === `Cannot read properties of undefined (reading 'put')`) {
		return c.json(result.fail('KV数据库未绑定 KV database not bound',502));
	}

	if (err.message === `Cannot read properties of undefined (reading 'prepare')`) {
		return c.json(result.fail('D1数据库未绑定 D1 database not bound',502));
	}

	return c.json(result.fail(err.message, err.code));
});

export default app;


